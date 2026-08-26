'use strict';


const REQUEST_EVENT = 'rucb-native-pac-request';
const RESPONSE_EVENT = 'rucb-native-pac-response';

document.documentElement.dataset.rucbBridge = 'ready';

window.addEventListener(REQUEST_EVENT, async () => {

  const requestId = document.documentElement.dataset.rucbRequestId;
  const rawRequest = document.documentElement.dataset.rucbRequest;
  let response;
  try {
    response = await browser.runtime.sendMessage(JSON.parse(rawRequest));
  } catch (error) {
    response = {
      error: {
        message: String(error && error.message || error || 'Unknown error'),
        name: String(error && error.name || 'Error'),
      },
      ok: false,
    };
  }
  document.documentElement.dataset.rucbResponse = JSON.stringify(response);
  document.documentElement.dataset.rucbResponseId = requestId;
  window.dispatchEvent(new CustomEvent(RESPONSE_EVENT));

});
