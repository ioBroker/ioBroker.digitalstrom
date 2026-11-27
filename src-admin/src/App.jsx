import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline } from '@mui/material';
import { GenericApp, I18n } from '@iobroker/adapter-react-v5';

import Settings from './Settings.jsx';
import { buildTheme } from './theme.js';
import translations from './i18n/index.js';
import {
    WarnLimitMonitor,
    classifyError,
    evaluateDraft,
    isNativeChanged,
    saveDialog,
    storedLimit,
} from './objectsWarnLimit.js';

// Closing with unsaved changes asked twice: GenericApp asks "discard?" inside the page and then
// tells admin to close - but admin still holds the "change" the page reported earlier and asks
// the same question again. GenericApp calls this static itself, both after that decision and
// when nothing was changed, so admin is told first that nothing is pending any more.
const closeDialog = GenericApp.onClose;
GenericApp.onClose = () => {
    try {
        window.parent.postMessage('nochange', '*');
    } catch {
        // not embedded in admin
    }
    closeDialog();
};

export default class App extends GenericApp {
    constructor(props) {
        super(props, {
            translations,
            // Deliberately no encryptedFields here. io-package.json already lists appToken
            // in encryptedNative, and GenericApp.onPrepareLoad decrypts both its own list
            // AND the fields of encryptedNative. Naming the token in both would decrypt it
            // twice, which returns the ciphertext again - saving from that state would
            // store a value the adapter cannot use.
            bottomButtons: true,
            sentryDSN: '',
        });
        this.dialogTheme = buildTheme();
        this.state = {
            ...this.state,
            alive: false,
            status: { connected: false, meteringApi: '', outputApi: '', activity: null },
            // The objects warn limit is a state of js-controller, not a setting of this adapter.
            // It lives next to native on purpose: reading it must never mark the dialog as changed,
            // and only a typed draft does.
            warnLimit: { snapshot: null, draft: null, draftBase: null, saving: false, saveError: '', saveAttempt: null },
        };
    }

    async onConnectionReady() {
        // Started first and on its own: it only needs admin, not a running instance, and a
        // refused status read below must not keep it from loading
        this.warnLimitMonitor = new WarnLimitMonitor({
            socket: this.socket,
            adapterName: this.adapterName,
            instance: this.instance,
            host: this.common && this.common.host,
            onUpdate: this.onWarnLimitSnapshot,
        });
        void this.warnLimitMonitor.start();

        const id = `system.adapter.${this.adapterName}.${this.instance}.alive`;
        this.aliveId = id;
        const state = await this.socket.getState(id);
        this.setState({ alive: !!(state && state.val) });
        await this.socket.subscribeState(id, this.onAliveChanged);

        // The status tab shows live which interface serves which task, and how much
        this.statusIds = ['info.connection', 'info.meteringApi', 'info.outputApi', 'info.apiActivity'].map(
            suffix => `${this.adapterName}.${this.instance}.${suffix}`,
        );
        for (const statusId of this.statusIds) {
            this.applyStatusState(statusId, await this.socket.getState(statusId));
            await this.socket.subscribeState(statusId, this.applyStatusState);
        }
    }

    onAliveChanged = (_id, state) => this.setState({ alive: !!(state && state.val) });

    applyStatusState = (id, state) => {
        const value = state ? state.val : null;
        if (id.endsWith('.info.connection')) {
            this.setState(old => ({ status: { ...old.status, connected: !!value } }));
        } else if (id.endsWith('.info.meteringApi')) {
            this.setState(old => ({ status: { ...old.status, meteringApi: value || '' } }));
        } else if (id.endsWith('.info.outputApi')) {
            this.setState(old => ({ status: { ...old.status, outputApi: value || '' } }));
        } else if (id.endsWith('.info.apiActivity')) {
            let parsed = null;
            try {
                parsed = value ? JSON.parse(String(value)) : null;
            } catch {
                parsed = null;
            }
            // Nur eine vollstaendige Antwort anzeigen - halbe Objekte wuerden im
            // Status-Tab zu "undefined"-Zahlen fuehren
            if (parsed && (!parsed.classic || !parsed.smarthome)) {
                parsed = null;
            }
            this.setState(old => ({ status: { ...old.status, activity: parsed } }));
        }
    };

    /**
     * A new reading of the warn limit. A draft the stored value has caught up with is dropped, and so
     * is the error of a save whose outcome was unknown once its value shows up after all.
     *
     * @param {any} snapshot
     */
    onWarnLimitSnapshot = snapshot =>
        this.setState(
            old => {
                const pending = evaluateDraft(old.warnLimit.draft, snapshot).dirty;
                const arrived =
                    old.warnLimit.saveAttempt !== null && storedLimit(snapshot) === old.warnLimit.saveAttempt;
                return {
                    warnLimit: {
                        ...old.warnLimit,
                        snapshot,
                        draft: pending ? old.warnLimit.draft : null,
                        draftBase: pending ? old.warnLimit.draftBase : null,
                        saveError: arrived ? '' : old.warnLimit.saveError,
                        saveAttempt: arrived ? null : old.warnLimit.saveAttempt,
                    },
                };
            },
            () => this.syncWarnLimitChanged(),
        );

    /**
     * The field of the card changed. null means it shows the stored value again.
     *
     * @param {string|null} draft
     */
    onWarnLimitDraft = draft =>
        this.setState(
            old => ({
                warnLimit: {
                    ...old.warnLimit,
                    draft,
                    saveError: '',
                    saveAttempt: null,
                    // what was stored when typing began - to notice a change from elsewhere
                    draftBase:
                        draft === null
                            ? null
                            : old.warnLimit.draft === null
                              ? storedLimit(old.warnLimit.snapshot)
                              : old.warnLimit.draftBase,
                },
            }),
            () => this.syncWarnLimitChanged(),
        );

    onWarnLimitRefresh = () => this.warnLimitMonitor && void this.warnLimitMonitor.refresh();

    /** Whether the settings themselves changed - see isNativeChanged for the encrypted tokens. */
    nativeChanged = () =>
        isNativeChanged(this.state.native, this.savedNative, this.encryptedFields, value => this.decrypt(value));

    /** Brings the save buttons and admin's "not saved" guard in line with the warn limit draft. */
    syncWarnLimitChanged() {
        const check = evaluateDraft(this.state.warnLimit.draft, this.state.warnLimit.snapshot);
        // Only an error this card raised is cleared again - told by ownership, not by its translated
        // text, which changes with the language
        if (check.dirty && !check.valid) {
            this.warnLimitConfigError = true;
            this.setConfigurationError(I18n.t('warnLimit_configError'));
        } else if (this.warnLimitConfigError) {
            this.warnLimitConfigError = false;
            this.setConfigurationError('');
        }
        if (this.warnLimitSaving) {
            // a running save sets the flag itself when it is done
            return;
        }
        const changed = this.getIsChanged(this.state.native);
        if (changed !== this.state.changed) {
            // GenericApp tells admin only from updateNativeValue - a draft has to do it itself
            try {
                window.parent.postMessage(changed ? 'change' : 'nochange', '*');
            } catch {
                // not embedded in admin
            }
            this.setState({ changed });
        }
    }

    /**
     * Whether the dialog holds anything unsaved. GenericApp compares native only, and after a save
     * that kept the dialog open it compares against the ENCRYPTED tokens, so an untouched form still
     * counts as changed - and saving it would restart the instance for nothing. A pending warn limit
     * counts as a change as well.
     *
     * @param {Record<string, any>} native
     */
    getIsChanged(native) {
        const changed =
            isNativeChanged(native || this.state.native, this.savedNative, this.encryptedFields, value =>
                this.decrypt(value),
            ) || evaluateDraft(this.state.warnLimit.draft, this.state.warnLimit.snapshot).dirty;
        globalThis.changed = changed;
        return changed;
    }

    /**
     * Saves the warn limit together with the settings - see saveDialog for the order and for why a
     * limit-only save leaves the instance object alone.
     *
     * @param {boolean} isClose
     */
    async onSave(isClose) {
        if (this.warnLimitSaving) {
            // A second click while the limit is still being written: remember a close, save once
            this.warnLimitCloseRequested = this.warnLimitCloseRequested || isClose;
            return;
        }
        if (this.state.isConfigurationError || !this.warnLimitMonitor) {
            return super.onSave(isClose);
        }
        const draft = this.state.warnLimit.draft;
        this.warnLimitSaving = true;
        this.warnLimitCloseRequested = isClose;
        this.setState(old => ({ warnLimit: { ...old.warnLimit, saving: true, saveError: '', saveAttempt: null } }));
        try {
            const result = await saveDialog({
                draft,
                snapshot: this.state.warnLimit.snapshot,
                monitor: this.warnLimitMonitor,
                nativeChanged: this.nativeChanged,
                saveSettings: () => super.onSave(this.warnLimitCloseRequested),
                finish: () => this.finishWarnLimitSave(draft),
            });
            if (result.outcome === 'failed') {
                const { kind, message, timedOut } = classifyError(result.error, this.socket.isConnected());
                const text = timedOut
                    ? I18n.t('warnLimit_save_timeout')
                    : kind === 'permission'
                      ? I18n.t('warnLimit_save_permission')
                      : kind === 'connection'
                        ? I18n.t('warnLimit_save_connection')
                        : I18n.t('warnLimit_save_failed').replace('{error}', message);
                this.setState(old => ({
                    // After a timeout the write may have arrived - a later reading will tell
                    warnLimit: { ...old.warnLimit, saveError: text, saveAttempt: timedOut ? result.value : null },
                }));
                this.showError(text);
            } else if (result.outcome === 'limit' || result.outcome === 'both') {
                // A value typed while the save was running is kept
                this.setState(old =>
                    old.warnLimit.draft === draft
                        ? { warnLimit: { ...old.warnLimit, draft: null, draftBase: null } }
                        : null,
                );
            }
        } finally {
            this.warnLimitSaving = false;
            this.setState(
                old => ({ warnLimit: { ...old.warnLimit, saving: false } }),
                () => this.syncWarnLimitChanged(),
            );
        }
    }

    /**
     * Ends a save that wrote no settings. Nothing is closed while a newer value is still pending.
     *
     * @param {string|null} savedDraft the draft this save wrote
     */
    finishWarnLimitSave(savedDraft) {
        const draft = this.state.warnLimit.draft;
        if (draft !== null && draft !== savedDraft && evaluateDraft(draft, this.state.warnLimit.snapshot).dirty) {
            return;
        }
        globalThis.changed = false;
        try {
            window.parent.postMessage('nochange', '*');
        } catch {
            // not embedded in admin
        }
        this.setState({ changed: false }, () => this.warnLimitCloseRequested && GenericApp.onClose());
    }

    componentWillUnmount() {
        if (this.warnLimitMonitor) {
            this.warnLimitMonitor.dispose();
        }
        if (this.aliveId) {
            this.socket.unsubscribeState(this.aliveId, this.onAliveChanged);
        }
        (this.statusIds || []).forEach(statusId => this.socket.unsubscribeState(statusId, this.applyStatusState));
        super.componentWillUnmount();
    }

    /**
     * Send a message to the running instance and resolve with its answer.
     *
     * @param command the command of the message handler in main.js
     * @param data payload of the message
     */
    sendToInstance = (command, data) =>
        this.socket.sendTo(`${this.adapterName}.${this.instance}`, command, data);

    render() {
        if (!this.state.loaded) {
            return super.render();
        }

        return (
            <ThemeProvider theme={this.dialogTheme}>
                <CssBaseline />
                <Settings
                    native={this.state.native}
                    alive={this.state.alive}
                    status={this.state.status}
                    t={key => I18n.t(key)}
                    onChange={(attr, value) => this.updateNativeValue(attr, value)}
                    onSendTo={this.sendToInstance}
                    lang={I18n.getLanguage()}
                    warnLimit={this.state.warnLimit.snapshot ? this.state.warnLimit : null}
                    onWarnLimitDraft={this.onWarnLimitDraft}
                    onWarnLimitRefresh={this.onWarnLimitRefresh}
                />
                {this.renderError()}
                {this.renderSaveCloseButtons()}
            </ThemeProvider>
        );
    }
}
