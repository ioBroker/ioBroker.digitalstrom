import React, { useEffect, useRef, useState } from 'react';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Divider,
    FormControlLabel,
    InputAdornment,
    Paper,
    Stack,
    Switch,
    Tab,
    Tabs,
    TextField,
    Typography,
} from '@mui/material';
import CableIcon from '@mui/icons-material/Cable';
import TuneIcon from '@mui/icons-material/Tune';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import KeyIcon from '@mui/icons-material/VpnKey';
import RouterIcon from '@mui/icons-material/Router';
import TimerIcon from '@mui/icons-material/Timer';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import BoltIcon from '@mui/icons-material/Bolt';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import DataObjectIcon from '@mui/icons-material/DataObject';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import { cardSx, DS_GREEN } from './theme.js';
import {
    WARN_LIMIT_QUESTIONS,
    copyText,
    describeWarnLimit,
    formatCount,
    parseLimitInput,
} from './objectsWarnLimit.js';

/**
 * Space that stays free below the content, in theme units (1 = 8px).
 *
 * The save bar of the admin is not part of the page: adapter-react-v5 renders it with
 * position absolute over the dialog. It is a MUI toolbar, so 64 px high, and in the old
 * admin iframe it additionally sits 38 px above the bottom edge - together 102 px that
 * cover the content and cannot be scrolled away either. 16 units = 128 px therefore keep
 * the last button of a tab reachable in both cases.
 */
const SAVE_BAR_SPACE = 16;

/**
 * Renders the **bold** markers of a translated text as real bold text, so the
 * translations can emphasise which data travels over which interface.
 *
 * @param {string} text
 */
function richText(text) {
    return text.split('**').map((part, index) => (index % 2 ? <strong key={index}>{part}</strong> : part));
}

/** One raised card with an icon, a title and an optional step number of the setup flow. */
function Card({ icon, title, step, children }) {
    return (
        <Paper sx={cardSx}>
            <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 2 }}>
                {step ? (
                    <Box
                        sx={{
                            width: 26,
                            height: 26,
                            borderRadius: '50%',
                            bgcolor: DS_GREEN,
                            color: '#fff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 14,
                            fontWeight: 700,
                            flexShrink: 0,
                        }}
                    >
                        {step}
                    </Box>
                ) : null}
                <Box sx={{ color: DS_GREEN, display: 'flex' }}>{icon}</Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    {title}
                </Typography>
            </Stack>
            <Divider sx={{ mb: 2.5, borderColor: '#eef2f5' }} />
            {children}
        </Paper>
    );
}

/** One row of the division-of-labour table: what runs, over which interface, how much. */
function ApiRow({ label, help, chip, activity }) {
    return (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ py: 1.25 }}>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500 }}>{label}</Typography>
                {help ? (
                    <Typography variant="body2" color="text.secondary">
                        {help}
                    </Typography>
                ) : null}
            </Box>
            <Box sx={{ flexShrink: 0, textAlign: { xs: 'left', sm: 'right' } }}>
                {chip}
                {activity ? (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        {activity}
                    </Typography>
                ) : null}
            </Box>
        </Stack>
    );
}

/** A switch with its explanation, laid out like a row of a list. */
function OptionRow({ checked, onChange, label, help }) {
    return (
        <Box sx={{ py: 0.5 }}>
            <FormControlLabel
                control={<Switch checked={!!checked} onChange={e => onChange(e.target.checked)} color="primary" />}
                label={<Typography sx={{ fontWeight: 500 }}>{label}</Typography>}
                sx={{ ml: 0, gap: 1.5 }}
            />
            {help ? (
                <Typography variant="body2" color="text.secondary" sx={{ ml: 7.5, mt: -0.25 }}>
                    {help}
                </Typography>
            ) : null}
        </Box>
    );
}

/**
 * Replaces the {placeholders} of a translated text.
 *
 * @param {string} text
 * @param {Record<string, any>} [params]
 */
function fill(text, params) {
    return Object.entries(params || {}).reduce((result, [name, value]) => result.split(`{${name}}`).join(String(value)), text);
}

/** One label/value pair of the warn limit card. On a narrow window the label sits above its value. */
function FactRow({ label, children }) {
    return (
        <>
            <Typography variant="body2" color="text.secondary" sx={{ pt: { sm: 0.25 } }}>
                {label}
            </Typography>
            <Box sx={{ minWidth: 0, mb: { xs: 1.5, sm: 0 } }}>{children}</Box>
        </>
    );
}

/**
 * The objects warn limit of this instance: what is set, what this adapter version suggests, and a
 * field to change it. The field is a draft until the dialog's own save button writes it - the
 * readings themselves never mark the dialog as changed.
 *
 * @param {object} props
 * @param {{ snapshot: any, draft: string|null, saveError: string }} props.warnLimit
 * @param {(text: string|null) => void} props.onDraft
 * @param {() => void} props.onRefresh
 * @param {(key: string) => string} props.t
 * @param {string} props.lang
 */
function WarnLimitCard({ warnLimit, onDraft, onRefresh, t, lang }) {
    const [copyState, setCopyState] = useState('');
    // One timer at a time, dropped when the card goes away
    const copyTimer = useRef(null);
    useEffect(() => () => clearTimeout(copyTimer.current), []);
    const view = describeWarnLimit(warnLimit.snapshot);
    const objects = n => fill(t('warnLimit_objects'), { n: formatCount(n, lang) });
    const current = view.current;
    const draft = warnLimit.draft;
    const parsed = draft === null ? null : parseLimitInput(draft);
    // The example is typed without separators, so it is the plain number - taken from what this
    // version suggests or what is set, never a number of its own
    const example = view.adapterDefault ?? (Number.isSafeInteger(current) && current > 0 ? current : null);
    const exampleText = example === null ? '' : String(example);

    let currentText;
    if (view.status === 'loading') {
        currentText = t('warnLimit_loading');
    } else if (current !== null) {
        currentText = objects(current);
    } else if (view.status === 'invalid') {
        currentText = t('warnLimit_invalidValue');
    } else if (view.status === 'noValue' || view.status === 'noObject') {
        currentText = t('warnLimit_notSet');
    } else if (view.status === 'unsupported') {
        currentText = t('warnLimit_unsupported');
    } else {
        currentText = t('warnLimit_unknown');
    }

    let defaultText;
    if (view.adapterDefaultStatus === 'loading') {
        defaultText = t('warnLimit_loading');
    } else if (view.adapterDefault !== null) {
        defaultText = objects(view.adapterDefault);
    } else {
        defaultText = t('warnLimit_unknown');
    }

    let helper;
    if (warnLimit.saving) {
        helper = t('warnLimit_saving');
    } else if (!view.editable) {
        helper = t('warnLimit_help_locked');
    } else if (parsed && !parsed.ok) {
        helper = t(`warnLimit_input_${parsed.reason}`);
    } else {
        helper = exampleText ? fill(t('warnLimit_help_edit'), { example: exampleText }) : t('warnLimit_help_editNoExample');
    }

    const onCopy = async () => {
        clearTimeout(copyTimer.current);
        setCopyState('');
        const copied = await copyText(view.stateId);
        setCopyState(copied ? 'copied' : 'failed');
        copyTimer.current = setTimeout(() => setCopyState(''), 4000);
    };

    return (
        <Card icon={<DataObjectIcon />} title={t('warnLimit_title')}>
            <Stack spacing={2.5}>
                <Typography variant="body2" sx={{ lineHeight: 1.7 }}>
                    {richText(t('warnLimit_info'))}
                </Typography>

                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', sm: 'minmax(180px, max-content) 1fr' },
                        columnGap: 3,
                        rowGap: { xs: 0, sm: 1.5 },
                        // start, not baseline: a wrapped state id would pull its label to the last line
                        alignItems: 'start',
                    }}
                >
                    <FactRow label={t('warnLimit_label_current')}>
                        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                            <Typography variant="h6" component="span" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
                                {currentText}
                            </Typography>
                            {view.loading && view.status !== 'loading' ? <CircularProgress size={14} /> : null}
                            {view.ack === false && current !== null ? (
                                <Chip size="small" variant="outlined" color="warning" label={t('warnLimit_ack_false')} />
                            ) : null}
                        </Stack>
                        {view.effective !== null ? (
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                                {fill(t('warnLimit_effective_fallback'), { value: objects(view.effective) })}
                            </Typography>
                        ) : null}
                    </FactRow>
                    <FactRow label={t('warnLimit_label_default')}>
                        <Typography component="span" sx={{ fontWeight: 500 }}>
                            {defaultText}
                        </Typography>
                        {view.adapterDefault !== null && view.adapterVersion ? (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                {fill(t('warnLimit_default_version'), { version: view.adapterVersion })}
                            </Typography>
                        ) : null}
                    </FactRow>
                    <FactRow label={t('warnLimit_label_source')}>
                        <Typography component="span">
                            {view.status === 'loading'
                                ? t('warnLimit_loading')
                                : current !== null
                                  ? t('warnLimit_source_state')
                                  : view.effective !== null
                                    ? t('warnLimit_source_fallback')
                                    : ['noAccess', 'disconnected', 'error'].includes(view.status)
                                      ? t('warnLimit_unknown')
                                      : t('warnLimit_source_none')}
                        </Typography>
                    </FactRow>
                    <FactRow label={t('warnLimit_label_state')}>
                        <Box
                            component="code"
                            sx={{
                                display: 'inline-block',
                                maxWidth: '100%',
                                fontFamily: '"Roboto Mono", Menlo, Consolas, monospace',
                                fontSize: 13,
                                bgcolor: '#f4f6f8',
                                border: '1px solid #e4e9ee',
                                borderRadius: 1,
                                px: 1,
                                py: 0.25,
                                overflowWrap: 'anywhere',
                                wordBreak: 'break-all',
                                userSelect: 'all',
                            }}
                        >
                            {view.stateId}
                        </Box>
                    </FactRow>
                </Box>

                {/* Reading actions sit with the reading: next to the field they looked like "apply" */}
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
                    <Button
                        variant="outlined"
                        onClick={onRefresh}
                        disabled={view.loading}
                        startIcon={view.loading ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
                    >
                        {t('warnLimit_button_refresh')}
                    </Button>
                    <Button variant="outlined" onClick={onCopy} startIcon={<ContentCopyIcon />}>
                        {t('warnLimit_button_copy')}
                    </Button>
                    {/* The live region is always there, so a screen reader announces the text when it
                        appears instead of missing a region that arrives together with it */}
                    <Typography
                        variant="body2"
                        role="status"
                        aria-live="polite"
                        color={copyState === 'copied' ? 'success.main' : 'text.secondary'}
                    >
                        {copyState === 'copied' ? t('warnLimit_copied') : copyState === 'failed' ? t('warnLimit_copyFailed') : ''}
                    </Typography>
                </Stack>

                {view.messages.map(message => (
                    <Alert
                        key={message.key}
                        severity={message.severity}
                        icon={message.severity === 'info' ? <InfoOutlinedIcon fontSize="inherit" /> : undefined}
                    >
                        {richText(
                            fill(t(message.key), {
                                ...message.params,
                                ...(message.params?.type ? { type: t(message.params.type) } : {}),
                                ...(typeof message.params?.fallback === 'number'
                                    ? { fallback: formatCount(message.params.fallback, lang) }
                                    : {}),
                            }),
                        )}
                    </Alert>
                ))}

                {/* What one wants to know before touching the number - the first two are open */}
                <Box>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        {t('warnLimit_faq_title')}
                    </Typography>
                    {WARN_LIMIT_QUESTIONS.map((question, index) => (
                        <Accordion
                            key={question}
                            defaultExpanded={index < 2}
                            disableGutters
                            elevation={0}
                            sx={{
                                border: '1px solid #e4e9ee',
                                '&:not(:last-of-type)': { borderBottom: 0 },
                                '&::before': { display: 'none' },
                            }}
                        >
                            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                <Typography sx={{ fontWeight: 500 }}>{t(`warnLimit_faq_${question}_q`)}</Typography>
                            </AccordionSummary>
                            <AccordionDetails sx={{ pt: 0 }}>
                                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                                    {richText(t(`warnLimit_faq_${question}_a`))}
                                </Typography>
                            </AccordionDetails>
                        </Accordion>
                    ))}
                </Box>

                <Divider sx={{ borderColor: '#eef2f5' }} />

                <Box>
                    <TextField
                        label={t('warnLimit_label_edit')}
                        value={draft !== null ? draft : current !== null && Number.isSafeInteger(current) ? String(current) : ''}
                        disabled={!view.editable || !!warnLimit.saving}
                        error={!!parsed && !parsed.ok}
                        onChange={e => {
                            const text = e.target.value;
                            const check = parseLimitInput(text);
                            // Typing the stored value back, or emptying a field that had no value, is
                            // no change any more
                            const unchanged = check.ok ? check.value === current : text.trim() === '' && current === null;
                            onDraft(unchanged ? null : text);
                        }}
                        helperText={helper}
                        sx={{ maxWidth: 320 }}
                        inputProps={{ inputMode: 'numeric', autoComplete: 'off', 'aria-label': t('warnLimit_label_edit') }}
                        InputProps={{ endAdornment: <InputAdornment position="end">{t('warnLimit_unit')}</InputAdornment> }}
                    />
                    {parsed && parsed.ok && !warnLimit.saving ? (
                        // A typed value is only a draft until the save bar below writes it
                        <Alert severity="warning" sx={{ mt: 1.5 }}>
                            {t('warnLimit_draft_pending')}
                        </Alert>
                    ) : null}
                    {draft !== null && current !== null && view.status !== 'loading' && warnLimit.draftBase !== current ? (
                        <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />} sx={{ mt: 1.5 }}>
                            {fill(t('warnLimit_draft_changedMeanwhile'), { value: objects(current) })}
                        </Alert>
                    ) : null}
                    {warnLimit.saveError ? (
                        <Alert severity="warning" sx={{ mt: 1.5 }}>
                            {warnLimit.saveError}
                        </Alert>
                    ) : null}
                </Box>

                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                    {richText(t('warnLimit_manual'))}
                </Typography>
            </Stack>
        </Card>
    );
}

export default function Settings({
    native,
    onChange,
    onSendTo,
    alive,
    t,
    initialTab = 0,
    status = null,
    warnLimit = null,
    onWarnLimitDraft = () => {},
    onWarnLimitRefresh = () => {},
    lang = 'en',
}) {
    const [tab, setTab] = useState(initialTab);
    // Not every field has an explanation. Both this preview and I18n return the key
    // itself when a text is missing, which must not end up on the screen.
    const th = key => (t(key) === key ? '' : t(key));
    // Which interface delivered the last reading - the chips of the status tab.
    // A WORKING classic path is just as green as the Smart Home path: the colour
    // means "alive", not "modern".
    const apiChip = (value, alive) =>
        value === 'smarthome' ? (
            <Chip size="small" color="success" icon={<BoltIcon />} label={t('api_smarthome')} />
        ) : value === 'classic' ? (
            <Chip
                size="small"
                color={alive ? 'success' : 'default'}
                variant={alive ? 'filled' : 'outlined'}
                icon={<KeyIcon />}
                label={t('api_classic')}
            />
        ) : (
            <Chip size="small" variant="outlined" label={t('api_waiting')} />
        );
    // "{n} Lesungen (letzte 10 min)" - die Zahlen kommen aus info.apiActivity
    const fmtActivity = (key, n) => (typeof n === 'number' ? t(key).replace('{n}', String(n)) : '');
    const activity = status && status.activity;
    const [credentials, setCredentials] = useState({ username: '', password: '' });
    const [showToken, setShowToken] = useState(false);
    // Der API-Key ist eine Zusatzoption - eingeklappt, solange keiner eingetragen ist
    const [showKeyOptions, setShowKeyOptions] = useState(false);
    // Ein bereits eingetragener Key wird immer gezeigt - sonst waere er unsichtbar
    const keySectionOpen = showKeyOptions || !!native.smartHomeApiKey;
    const [tokenState, setTokenState] = useState({ running: false, error: '', done: false });

    const createToken = async () => {
        setTokenState({ running: true, error: '', done: false });
        try {
            const res = await onSendTo('createAppToken', {
                host: native.host || '',
                username: credentials.username,
                password: credentials.password,
            });
            if (res && res.error) {
                setTokenState({ running: false, error: res.error, done: false });
            } else if (res && res.appToken) {
                onChange('appToken', res.appToken);
                setCredentials({ username: '', password: '' });
                setTokenState({ running: false, error: '', done: true });
            } else {
                setTokenState({ running: false, error: 'no answer from the instance', done: false });
            }
        } catch (e) {
            setTokenState({ running: false, error: (e && e.message) || String(e), done: false });
        }
    };

    const canCreate = !!native.host && !!credentials.username && !!credentials.password && !tokenState.running;

    const [keyState, setKeyState] = useState({ running: false, error: '', done: false });
    const [showKey, setShowKey] = useState(false);

    // Der API-Key entsteht aus dem vorhandenen App-Token, deshalb braucht dieser Knopf
    // keine Anmeldedaten - nur eine laufende Instanz, die den Token entschluesseln kann.
    const createSmartHomeKey = async () => {
        setKeyState({ running: true, error: '', done: false });
        try {
            // Der App-Token aus dem FORMULAR wird mitgesendet: der Knopf ist aktiv, sobald
            // das Formular einen Token zeigt - auch einen frisch erstellten, noch nicht
            // gespeicherten. Ohne ihn wuerde die Instanz auf den GESPEICHERTEN Token
            // zurueckfallen und im Neueinrichtungs-Flow "kein App-Token" melden.
            const res = await onSendTo('createSmartHomeKey', {
                host: native.host,
                appToken: native.appToken || '',
            });
            if (res && res.error) {
                setKeyState({ running: false, error: res.error, done: false });
            } else if (res && res.apiKey) {
                onChange('smartHomeApiKey', res.apiKey);
                setKeyState({ running: false, error: '', done: true });
            } else {
                setKeyState({ running: false, error: 'no answer from the instance', done: false });
            }
        } catch (e) {
            setKeyState({ running: false, error: (e && e.message) || String(e), done: false });
        }
    };

    return (
        // Der Dialog scrollt SELBST. Verlaesst man sich darauf, dass der umgebende Rahmen
        // das tut, ist alles unterhalb der ersten Bildschirmhoehe unerreichbar, sobald der
        // Rahmen overflow:hidden setzt - und dann hilft auch kein Abstand am unteren Rand.
        // 100vh gibt eine definierte Hoehe, overflowY macht daraus einen eigenen Scroller.
        <Box sx={{ height: '100vh', overflowY: 'auto', bgcolor: 'background.default' }}>
            {/* Kopfbereich mit Symbol, Name und Kurzbeschreibung */}
            <Box
                sx={{
                    background: 'linear-gradient(180deg, #eef7ef 0%, #f7fbf8 100%)',
                    borderBottom: '1px solid #e2ebe4',
                    px: { xs: 2, sm: 4 },
                    pt: 3,
                }}
            >
                <Stack direction="row" spacing={2} alignItems="center">
                    <Box
                        component="img"
                        src="./digitalstrom.png"
                        alt=""
                        sx={{
                            width: 56,
                            height: 56,
                            borderRadius: '50%',
                            bgcolor: '#fff',
                            p: 0.75,
                            border: '1px solid #e2ebe4',
                            objectFit: 'contain',
                        }}
                    />
                    <Box>
                        <Typography variant="h5">digitalSTROM</Typography>
                        <Typography variant="body2" color="text.secondary">
                            {t('app_subtitle')}
                        </Typography>
                    </Box>
                </Stack>

                <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mt: 1.5 }} textColor="primary" indicatorColor="primary">
                    <Tab icon={<CableIcon fontSize="small" />} iconPosition="start" label={t('tab_connection')} />
                    <Tab icon={<SwapHorizIcon fontSize="small" />} iconPosition="start" label={t('tab_status')} />
                    <Tab icon={<TuneIcon fontSize="small" />} iconPosition="start" label={t('tab_settings')} />
                    <Tab icon={<InfoOutlinedIcon fontSize="small" />} iconPosition="start" label={t('tab_notes')} />
                </Tabs>
            </Box>

            {/* The admin lays its save bar OVER the content, so the space below has to be
                kept free here - see SAVE_BAR_SPACE. */}
            <Box sx={{ px: { xs: 2, sm: 4 }, pt: 3, pb: SAVE_BAR_SPACE, maxWidth: 1400 }}>
                {tab === 0 ? (
                    // Auf einem PC-Bildschirm ist Platz genug: 1 und 2 nebeneinander,
                    // 3 unter der 1. Auf schmalen Fenstern stapelt sich alles wie gehabt.
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                            columnGap: 3,
                            alignItems: 'start',
                        }}
                    >
                        <Box sx={{ minWidth: 0 }}>
                        <Card icon={<RouterIcon />} title={t('section_server')} step={1}>
                            <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />} sx={{ mb: 2.5 }}>
                                {t('info_server')}
                            </Alert>
                            <Stack spacing={2.5}>
                                <TextField
                                    label={t('label_host')}
                                    value={native.host || ''}
                                    onChange={e => onChange('host', e.target.value)}
                                    helperText={th('help_host')}
                                    sx={{ maxWidth: 460 }}
                                />
                                <OptionRow
                                    checked={native.validateCertificate}
                                    onChange={v => onChange('validateCertificate', v)}
                                    label={t('label_validateCertificate')}
                                    help={th('help_validateCertificate')}
                                />
                            </Stack>
                        </Card>
                        </Box>

                        <Box sx={{ minWidth: 0, gridColumn: { md: '2' }, gridRow: { md: '1 / span 2' } }}>
                        <Card icon={<KeyIcon />} title={t('section_token')} step={2}>
                            <Stack spacing={2.5}>
                                <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />}>
                                    {richText(t('info_token_role'))}
                                </Alert>

                                {/* Einrichtungsreihenfolge: erst die Anmeldedaten, der
                                    erstellte Token landet im Feld darunter */}
                                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ maxWidth: 640 }}>
                                    <TextField
                                        label={t('label_username')}
                                        value={credentials.username}
                                        autoComplete="off"
                                        onChange={e => setCredentials(c => ({ ...c, username: e.target.value }))}
                                    />
                                    <TextField
                                        label={t('label_password')}
                                        type="password"
                                        value={credentials.password}
                                        autoComplete="new-password"
                                        onChange={e => setCredentials(c => ({ ...c, password: e.target.value }))}
                                    />
                                </Stack>
                                <Typography variant="body2" color="text.secondary" sx={{ mt: -1.5 }}>
                                    {t('info_token')}
                                </Typography>

                                <Box>
                                    <Button
                                        variant="contained"
                                        disabled={!canCreate || alive === false}
                                        onClick={createToken}
                                        startIcon={
                                            tokenState.running ? <CircularProgress size={16} color="inherit" /> : <KeyIcon />
                                        }
                                    >
                                        {t('button_createToken')}
                                    </Button>
                                </Box>

                                {tokenState.error ? <Alert severity="error">{tokenState.error}</Alert> : null}
                                {tokenState.done ? <Alert severity="success">{t('token_created')}</Alert> : null}

                                <Divider sx={{ borderColor: '#eef2f5' }} />

                                <Box>
                                    <TextField
                                        label={t('label_appToken')}
                                        type={showToken ? 'text' : 'password'}
                                        value={native.appToken || ''}
                                        onChange={e => onChange('appToken', e.target.value)}
                                        helperText={th('help_appToken')}
                                        sx={{ maxWidth: 560 }}
                                        InputProps={{
                                            endAdornment: (
                                                <InputAdornment position="end">
                                                    <Button
                                                        size="small"
                                                        onClick={() => setShowToken(v => !v)}
                                                        sx={{ minWidth: 0, color: 'text.secondary' }}
                                                    >
                                                        {showToken ? (
                                                            <VisibilityOffIcon fontSize="small" />
                                                        ) : (
                                                            <VisibilityIcon fontSize="small" />
                                                        )}
                                                    </Button>
                                                </InputAdornment>
                                            ),
                                        }}
                                    />
                                    <Box sx={{ mt: 1 }}>
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            color={native.appToken ? 'success' : 'default'}
                                            icon={native.appToken ? <CheckCircleIcon /> : undefined}
                                            label={native.appToken ? t('token_present') : t('token_missing')}
                                        />
                                    </Box>
                                </Box>
                            </Stack>
                        </Card>
                        </Box>

                        <Box sx={{ minWidth: 0, gridColumn: { md: '1' } }}>
                        <Card icon={<BoltIcon />} title={t('section_smartHome')} step={3}>
                            <Stack spacing={2.5}>
                                <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />}>
                                    {richText(t('info_smartHome'))}
                                </Alert>

                                <OptionRow
                                    checked={native.useSmartHomeApi}
                                    onChange={v => onChange('useSmartHomeApi', v)}
                                    label={t('label_useSmartHomeApi')}
                                    help={th('help_useSmartHomeApi')}
                                />

                                {!keySectionOpen ? (
                                    <Box>
                                        <Button
                                            size="small"
                                            onClick={() => setShowKeyOptions(true)}
                                            sx={{ color: 'text.secondary', pl: 0 }}
                                            startIcon={<KeyIcon fontSize="small" />}
                                        >
                                            {t('button_showKeyOptions')}
                                        </Button>
                                    </Box>
                                ) : null}

                                {keySectionOpen ? (
                                    <>
                                <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />}>
                                    {richText(t('info_apiKeyOptional'))}
                                </Alert>

                                <Box>
                                    <TextField
                                        label={t('label_smartHomeApiKey')}
                                        type={showKey ? 'text' : 'password'}
                                        value={native.smartHomeApiKey || ''}
                                        onChange={e => onChange('smartHomeApiKey', e.target.value)}
                                        helperText={th('help_smartHomeApiKey')}
                                        sx={{ maxWidth: 560 }}
                                        InputProps={{
                                            endAdornment: (
                                                <InputAdornment position="end">
                                                    <Button
                                                        size="small"
                                                        onClick={() => setShowKey(v => !v)}
                                                        sx={{ minWidth: 0, color: 'text.secondary' }}
                                                    >
                                                        {showKey ? (
                                                            <VisibilityOffIcon fontSize="small" />
                                                        ) : (
                                                            <VisibilityIcon fontSize="small" />
                                                        )}
                                                    </Button>
                                                </InputAdornment>
                                            ),
                                        }}
                                    />
                                    <Box sx={{ mt: 1 }}>
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            color={native.smartHomeApiKey ? 'success' : 'default'}
                                            icon={native.smartHomeApiKey ? <CheckCircleIcon /> : undefined}
                                            label={native.smartHomeApiKey ? t('key_present') : t('key_missing')}
                                        />
                                    </Box>
                                </Box>

                                <Box>
                                    <Button
                                        variant="contained"
                                        disabled={!native.appToken || keyState.running || alive === false}
                                        onClick={createSmartHomeKey}
                                        startIcon={
                                            keyState.running ? (
                                                <CircularProgress size={16} color="inherit" />
                                            ) : (
                                                <KeyIcon />
                                            )
                                        }
                                    >
                                        {t('button_createSmartHomeKey')}
                                    </Button>
                                </Box>

                                {keyState.error ? <Alert severity="error">{keyState.error}</Alert> : null}
                                {keyState.done ? <Alert severity="success">{t('key_created')}</Alert> : null}
                                    </>
                                ) : null}
                            </Stack>
                        </Card>
                        </Box>
                    </Box>
                ) : null}

                {tab === 1 ? (
                    <Card icon={<SwapHorizIcon />} title={t('section_status')}>
                        <Stack spacing={2.5}>
                            <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />}>
                                {t('info_status')}
                            </Alert>
                            {alive === false ? <Alert severity="warning">{t('status_not_running')}</Alert> : null}
                            <Stack divider={<Divider sx={{ borderColor: '#eef2f5' }} />}>
                                <ApiRow
                                    label={t('status_connection')}
                                    help={th('status_connection_help')}
                                    chip={
                                        <Chip
                                            size="small"
                                            color={status && status.connected ? 'success' : 'default'}
                                            variant={status && status.connected ? 'filled' : 'outlined'}
                                            icon={status && status.connected ? <CheckCircleIcon /> : undefined}
                                            label={
                                                status && status.connected
                                                    ? t('status_connected')
                                                    : t('status_disconnected')
                                            }
                                        />
                                    }
                                />
                                <ApiRow
                                    label={t('status_events')}
                                    help={th('status_events_help')}
                                    chip={apiChip('classic', status && status.connected)}
                                    activity={
                                        activity &&
                                        t('activity_events_commands')
                                            .replace('{e}', String(activity.classic.events || 0))
                                            .replace('{c}', String(activity.classic.commands || 0))
                                    }
                                />
                                <ApiRow
                                    label={t('status_meters')}
                                    help={th('status_meters_help')}
                                    chip={apiChip(status && status.meteringApi, status && status.connected)}
                                    activity={
                                        activity &&
                                        fmtActivity(
                                            'activity_reads',
                                            status && status.meteringApi === 'smarthome'
                                                ? activity.smarthome.meterReads
                                                : activity.classic.meterReads,
                                        )
                                    }
                                />
                                <ApiRow
                                    label={t('status_outputs')}
                                    help={th('status_outputs_help')}
                                    chip={apiChip(status && status.outputApi, status && status.connected)}
                                    activity={
                                        activity &&
                                        fmtActivity(
                                            'activity_reads',
                                            status && status.outputApi === 'smarthome'
                                                ? activity.smarthome.statusReads
                                                : activity.classic.outputReads,
                                        )
                                    }
                                />
                                <ApiRow
                                    label={t('status_notifications')}
                                    help={th('status_notifications_help')}
                                    chip={
                                        activity && activity.smarthome.notifications > 0 ? (
                                            <Chip
                                                size="small"
                                                color="success"
                                                icon={<BoltIcon />}
                                                label={t('api_smarthome')}
                                            />
                                        ) : (
                                            <Chip size="small" variant="outlined" label={t('api_smarthome')} />
                                        )
                                    }
                                    activity={
                                        activity && fmtActivity('activity_messages', activity.smarthome.notifications)
                                    }
                                />
                            </Stack>
                        </Stack>
                    </Card>
                ) : null}

                {tab === 2 ? (
                    <>
                        <Card icon={<TimerIcon />} title={t('section_options')}>
                            <TextField
                                label={t('label_dataPollInterval')}
                                type="number"
                                value={native.dataPollInterval ?? 100}
                                onChange={e => onChange('dataPollInterval', parseInt(e.target.value, 10))}
                                helperText={th('help_dataPollInterval')}
                                sx={{ maxWidth: 320 }}
                                InputProps={{ endAdornment: <InputAdornment position="end">{t('unit_seconds')}</InputAdornment> }}
                            />
                        </Card>

                        <Card icon={<TuneRoundedIcon />} title={t('section_behaviour')}>
                            <Stack spacing={1.5} divider={<Divider sx={{ borderColor: '#eef2f5' }} />}>
                                <OptionRow
                                    checked={native.usePresetValues}
                                    onChange={v => onChange('usePresetValues', v)}
                                    label={t('label_usePresetValues')}
                                    help={th('help_usePresetValues')}
                                />
                                <OptionRow
                                    checked={native.initializeOutputValues}
                                    onChange={v => onChange('initializeOutputValues', v)}
                                    label={t('label_initializeOutputValues')}
                                    help={th('help_initializeOutputValues')}
                                />
                                <OptionRow
                                    checked={native.deleteUnknownObjects}
                                    onChange={v => onChange('deleteUnknownObjects', v)}
                                    label={t('label_deleteUnknownObjects')}
                                    help={th('help_deleteUnknownObjects')}
                                />
                            </Stack>
                        </Card>

                        {warnLimit ? (
                            <WarnLimitCard
                                warnLimit={warnLimit}
                                onDraft={onWarnLimitDraft}
                                onRefresh={onWarnLimitRefresh}
                                t={t}
                                lang={lang}
                            />
                        ) : null}
                    </>
                ) : null}

                {tab === 3 ? (
                    <>
                        <Card icon={<SwapHorizIcon />} title={t('section_why')}>
                            <Typography variant="body2" sx={{ lineHeight: 1.7 }}>
                                {richText(t('info_why'))}
                            </Typography>
                        </Card>
                        <Card icon={<KeyIcon />} title={t('section_credentials')}>
                            <Typography variant="body2" sx={{ lineHeight: 1.7 }}>
                                {richText(t('info_credentials'))}
                            </Typography>
                        </Card>
                        <Card icon={<InfoOutlinedIcon />} title={t('section_notes')}>
                        <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />}>
                            {t('info_tls')}
                        </Alert>
                        </Card>
                    </>
                ) : null}
            </Box>
        </Box>
    );
}
