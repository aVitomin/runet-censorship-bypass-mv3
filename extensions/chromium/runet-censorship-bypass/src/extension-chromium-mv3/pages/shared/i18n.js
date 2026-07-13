'use strict';

(function(exports) {

  const SUPPORTED_LANGUAGES = Object.freeze(['en', 'ru']);
  let activeLanguage = null;
  let activeMessages = null;

  function normalizeLanguage(value) {

    const language = String(value || 'auto').toLowerCase();
    return SUPPORTED_LANGUAGES.includes(language) ? language : 'auto';

  }

  function getBrowserLanguage() {

    const uiLanguage = chrome.i18n && chrome.i18n.getUILanguage ?
      chrome.i18n.getUILanguage() :
      '';
    return String(uiLanguage || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';

  }

  function getEffectiveLanguage(value) {

    const language = normalizeLanguage(value);
    return language === 'auto' ? getBrowserLanguage() : language;

  }

  async function init(preferredLanguage) {

    const language = getEffectiveLanguage(preferredLanguage);
    if (activeLanguage === language && activeMessages) {
      return {language};
    }
    activeMessages = await loadMessages(language);
    activeLanguage = language;
    document.documentElement.lang = language;
    return {language};

  }

  async function loadMessages(language) {

    const response = await fetch(
        chrome.runtime.getURL(`_locales/${language}/messages.json`),
    );
    if (!response.ok) {
      throw new Error(`Failed to load ${language} locale.`);
    }
    return response.json();

  }

  function t(key, substitutions) {

    const entry = activeMessages && activeMessages[key];
    if (entry && typeof entry.message === 'string') {
      return applySubstitutions(entry, substitutions);
    }
    return chrome.i18n.getMessage(key, substitutions) || key;

  }

  function applySubstitutions(entry, substitutions) {

    const values = Array.isArray(substitutions) ?
      substitutions.map(String) :
      substitutions === undefined ? [] : [String(substitutions)];
    let text = entry.message;
    values.forEach((value, index) => {
      text = text.replace(new RegExp(`\\$${index + 1}`, 'g'), value);
    });
    Object.keys(entry.placeholders || {}).forEach((name) => {
      const placeholder = entry.placeholders[name] || {};
      const match = String(placeholder.content || '').match(/^\$(\d+)$/);
      if (!match) {
        return;
      }
      const value = values[Number(match[1]) - 1] || '';
      text = text.replace(new RegExp(`\\$${name}\\$`, 'gi'), value);
    });
    return text;

  }

  exports.mv3I18n = Object.freeze({
    init,
    t,
    getEffectiveLanguage,
    normalizeLanguage,
  });

})(window);
