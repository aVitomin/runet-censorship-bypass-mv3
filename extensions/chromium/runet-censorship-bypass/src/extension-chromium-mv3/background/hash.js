'use strict';

(function(exports) {

  function bytesToHex(bytes) {

    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');

  }

  async function sha256Hex(text) {

    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error('Web Crypto SHA-256 is unavailable.');
    }
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));

  }

  function getUtf8Length(text) {

    if (typeof TextEncoder === 'undefined') {
      return text.length;
    }
    return new TextEncoder().encode(text).byteLength;

  }

  exports.mv3Hash = Object.freeze({
    sha256Hex,
    getUtf8Length,
  });

})(self);
