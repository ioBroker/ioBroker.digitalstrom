import { createTheme } from '@mui/material/styles';

// The colours are taken from the digitalSTROM logo.
export const DS_GREEN = '#00662E';
export const DS_LIME = '#7FC241';

// The dialog deliberately stays light, independent of the admin theme: a settings
// page is read more than it is looked at, and the light surface keeps the cards
// legible. Only the surrounding admin frame follows the user's theme.
export const buildTheme = () =>
    createTheme({
        palette: {
            mode: 'light',
            primary: { main: DS_GREEN, contrastText: '#ffffff' },
            secondary: { main: DS_LIME, contrastText: '#0d2b16' },
            background: { default: '#f4f6f8', paper: '#ffffff' },
            text: { primary: '#1b2429', secondary: '#5a6b74' },
        },
        shape: { borderRadius: 12 },
        typography: {
            fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
            h5: { fontWeight: 600, letterSpacing: '-0.01em' },
            subtitle2: { fontWeight: 600, letterSpacing: '0.02em' },
        },
        components: {
            MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
            MuiTextField: { defaultProps: { variant: 'outlined', size: 'small', fullWidth: true } },
            MuiButton: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } } },
            MuiTab: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600, minHeight: 52 } } },
        },
    });

// The raised card is the recurring element of the page.
export const cardSx = {
    p: { xs: 2, sm: 3 },
    mb: 2.5,
    borderRadius: 3,
    border: '1px solid #e4e9ee',
    boxShadow: '0 1px 2px rgba(16,32,44,0.05), 0 12px 28px -18px rgba(16,32,44,0.45)',
};
