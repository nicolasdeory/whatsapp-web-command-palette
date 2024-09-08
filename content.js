function injectScript(src) {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL(src);
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
}

injectScript('inject.js');

console.log("Content script started");