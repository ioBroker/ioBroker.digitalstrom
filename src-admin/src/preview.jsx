// Design preview only. Renders the settings page with fixed data and without any
// connection to a running instance, so the layout can be looked at during development.
// This entry point is not part of the built admin interface.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { Box, CssBaseline, Fab, Toolbar } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import Settings from './Settings.jsx';
import { buildTheme } from './theme.js';
import { WarnLimitMonitor, storedLimit, warnLimitStateId } from './objectsWarnLimit.js';
import de from './i18n/de.json';
import en from './i18n/en.json';

const dict = { de, en };

/**
 * A pretend admin connection for the warn limit card, so every case can be looked at:
 * ?warnLimit=5000 | 15000 | text | empty | none | noObject | old | denied | zero, ?instance=1, ?draft=12000.
 *
 * @param {string} scenario
 * @param {number} instance
 */
function previewSocket(scenario, instance) {
    const id = warnLimitStateId('digitalstrom', instance);
    const numeric = /^\d+$/.test(scenario) ? Number(scenario) : null;
    const states = {};
    if (numeric !== null) {
        states[id] = { val: numeric, ack: true };
    } else if (scenario === 'text') {
        states[id] = { val: '10000', ack: false };
    } else if (scenario === 'empty') {
        states[id] = { val: null, ack: true };
    } else if (scenario === 'zero') {
        states[id] = { val: 0, ack: true };
    }
    const objects = {
        [`system.adapter.digitalstrom.${instance}`]: {
            common: { host: 'preview', version: '2.4.23', defaultObjectsWarnLimit: 10000 },
        },
        'system.host.preview': { common: { installedVersion: scenario === 'old' ? '7.0.7' : '7.2.2' } },
    };
    if (scenario !== 'noObject' && scenario !== 'old') {
        objects[id] = { common: { type: 'number' } };
    }
    const listeners = [];
    const answer = value => new Promise(resolve => setTimeout(() => resolve(value), 300));
    return {
        getState: sid => (scenario === 'denied' ? Promise.reject('permissionError') : answer(states[sid] ?? null)),
        getObject: oid => answer(objects[oid] ?? null),
        subscribeState: async (sid, cb) => listeners.push(cb),
        unsubscribeState: () => {},
        setState: async (sid, state) => {
            states[sid] = state;
            listeners.forEach(cb => cb(sid, state));
        },
    };
}

/**
 * Imitates the save bar of the admin, which adapter-react-v5 renders with position
 * absolute OVER the dialog. Without it the preview would show more room at the bottom
 * edge than the dialog really has.
 *
 * @param {object} props
 * @param {number} props.offset distance to the bottom edge - 38px in the old admin iframe
 * @param {string} props.lang the admin labels its bar in the language of the dialog
 */
function SaveBarStandIn({ offset, lang }) {
    const label = lang === 'de' ? ['SPEICHERN', 'SPEICHERN UND SCHLIESSEN', 'SCHLIESSEN'] : ['SAVE', 'SAVE AND CLOSE', 'CLOSE'];
    const buttonStyle = { borderRadius: 3, height: 32 };
    return (
        <Toolbar sx={{ position: 'absolute', left: 0, right: 0, bottom: offset, background: '#2a9fd6' }}>
            <Fab variant="extended" aria-label="Save" style={buttonStyle}>
                <SaveIcon sx={{ mr: 1 }} />
                {label[0]}
            </Fab>
            <Fab variant="extended" aria-label="Save and close" style={{ ...buttonStyle, marginLeft: 10 }}>
                <SaveIcon sx={{ mr: 1 }} />
                {label[1]}
            </Fab>
            <Box sx={{ flexGrow: 1 }} />
            <Fab variant="extended" aria-label="Close" style={buttonStyle}>
                <CloseIcon sx={{ mr: 1 }} />
                {label[2]}
            </Fab>
        </Toolbar>
    );
}

function Preview() {
    const params = new URLSearchParams(location.search);
    const lang = params.get('lang') || 'de';
    const initialTab = parseInt(params.get('tab') || '0', 10);
    // ?iframe=1 shows the variant of the old admin, where the bar sits 38px higher
    const barOffset = params.get('iframe') === '1' ? 38 : 0;
    const noscroll = params.get('noscroll') === '1';
    const words = dict[lang] || dict.en;
    // ?draft=12000 shows a typed but unsaved value, as in the README screenshot
    const initialDraft = params.get('draft');
    const [warnLimit, setWarnLimit] = useState({
        snapshot: null,
        draft: initialDraft,
        draftBase: initialDraft === null ? null : Number(params.get('warnLimit') || '5000'),
        saveError: '',
    });
    const [monitor] = useState(
        () =>
            new WarnLimitMonitor({
                socket: previewSocket(params.get('warnLimit') || '5000', parseInt(params.get('instance') || '0', 10)),
                adapterName: 'digitalstrom',
                instance: parseInt(params.get('instance') || '0', 10),
                host: 'preview',
                onUpdate: snapshot => setWarnLimit(old => ({ ...old, snapshot })),
            }),
    );
    useEffect(() => {
        void monitor.start();
        return () => monitor.dispose();
    }, [monitor]);
    const [native, setNative] = useState({
        host: '192.168.1.10',
        validateCertificate: false,
        appToken: '0123456789abcdef0123456789abcdef',
        useSmartHomeApi: true,
        // Der Normalfall seit 2.4.21: kein eigener Schluessel, der App-Token genuegt
        smartHomeApiKey: '',
        dataPollInterval: 100,
        usePresetValues: true,
        initializeOutputValues: true,
        deleteUnknownObjects: false,
    });
    // Sample of a running hybrid instance for the status tab
    const status = {
        connected: true,
        meteringApi: 'smarthome',
        outputApi: 'smarthome',
        activity: {
            windowMinutes: 10,
            classic: { requests: 14, events: 23, commands: 7, meterReads: 0, outputReads: 0 },
            smarthome: { requests: 9, meterReads: 6, statusReads: 3, notifications: 41 },
        },
    };

    return (
        <ThemeProvider theme={buildTheme()}>
            <CssBaseline />
            {/* Same geometry as the admin: the dialog fills the window and scrolls inside
                it, the save bar lies on top and stays at the bottom edge. */}
            <Box sx={{ position: 'relative', height: '100vh', overflow: 'hidden' }}>
                {/* ?noscroll=1 ahmt einen Rahmen nach, der NICHT scrollt - der schlimmste Fall */}
                <Box sx={{ height: '100%', overflow: noscroll ? 'hidden' : 'auto' }}>
                    <Settings
                        native={native}
                        onChange={(attr, value) => setNative(n => ({ ...n, [attr]: value }))}
                        onSendTo={async () => ({ appToken: 'ffffffffffffffffffffffffffffffff' })}
                        alive
                        status={status}
                        initialTab={initialTab}
                        t={key => words[key] || key}
                        lang={lang}
                        warnLimit={warnLimit.snapshot ? warnLimit : null}
                        onWarnLimitDraft={draft =>
                            setWarnLimit(old => ({
                                ...old,
                                draft,
                                draftBase: draft === null ? null : old.draft === null ? storedLimit(old.snapshot) : old.draftBase,
                            }))
                        }
                        onWarnLimitRefresh={() => void monitor.refresh()}
                    />
                </Box>
                <SaveBarStandIn offset={barOffset} lang={lang} />
            </Box>
        </ThemeProvider>
    );
}

createRoot(document.getElementById('root')).render(<Preview />);
