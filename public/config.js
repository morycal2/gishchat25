// Backend URL. When this frontend is served by the Railway backend itself, use the same origin.
// For GitHub Pages or another separate frontend, replace this with your backend URL.
const sameOrigin = /(^|\.)railway\.app$/i.test(window.location.hostname);
window.GISH_CONFIG={API_URL: sameOrigin ? window.location.origin : 'https://YOUR-SERVICE.onrender.com'};
