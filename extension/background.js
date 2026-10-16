// FormDitto service worker.
// Opens the side panel when the toolbar icon is clicked (the click also grants activeTab for that
// tab) and keeps chrome.storage.local readable by extension pages only.

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open() must be called synchronously inside the user gesture.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  // An already open panel refreshes its view of the tab, which it can now read thanks to activeTab.
  chrome.runtime.sendMessage({ type: 'ff:action-clicked', tabId: tab.id }).catch(() => {});
});
