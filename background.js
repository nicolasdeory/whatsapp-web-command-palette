chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url.startsWith('https://web.whatsapp.com/')) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['inject.js']
    });
  }
});