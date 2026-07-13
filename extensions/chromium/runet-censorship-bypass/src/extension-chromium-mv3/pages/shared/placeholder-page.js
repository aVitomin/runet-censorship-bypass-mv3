'use strict';

(async function() {

  const root = document.getElementById('mv3-page-root');
  const page = document.body.dataset.mv3Page || 'unknown';
  const pageTitle = document.body.dataset.mv3PageTitle || page;

  function appendText(parent, tagName, text) {

    const node = document.createElement(tagName);
    node.textContent = text;
    parent.appendChild(node);
    return node;

  }

  function renderStatus(state, status) {

    root.replaceChildren();
    appendText(root, 'h1', 'Runet Censorship Bypass');
    appendText(
        root,
        'p',
        'This page is loaded through the current extension build and communicates with the ' +
        'background service worker through RPC.',
    );
    appendText(root, 'p', status.status);

    const details = document.createElement('dl');
    root.appendChild(details);

    appendText(details, 'dt', 'Page');
    appendText(details, 'dd', pageTitle);
    appendText(details, 'dt', 'Background');
    appendText(details, 'dd', state.status);
    appendText(details, 'dt', 'PAC/proxy');
    appendText(details, 'dd', state.pac.status);

  }

  function renderError(err) {

    root.replaceChildren();
    appendText(root, 'h1', 'Runet Censorship Bypass');
    appendText(root, 'p', 'Background RPC failed.');
    appendText(root, 'pre', err && err.message ? err.message : String(err));

  }

  try {
    const rpc = window.mv3Rpc;
    const state = await rpc.callBackground('getState');
    const status = await rpc.callBackground('getPageStatus', {page});
    renderStatus(state, status);
  } catch (err) {
    renderError(err);
  }

})();
