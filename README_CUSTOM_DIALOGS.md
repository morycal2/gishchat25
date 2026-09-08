# Zento Custom Dialogs

- Replaced in-app browser `prompt()` / `confirm()` flows with a custom Zento dialog UI.
- Covers PIN entry, folder naming, forward destination, account deletion, bot deletion, conversation actions, and related confirmation/input flows.
- Added keyboard Escape/Enter handling, dark mode support, RTL layout, responsive mobile sizing, and backdrop dismissal.
- Browser PWA installation prompt remains native because it is controlled by the browser installation API rather than an application confirmation dialog.
