'use strict';

/* global mv3State */

(function(exports) {

  const ALARM_NAME = 'pac.periodicUpdate';
  const RETRY_ALARM_NAME = 'pac.retryUpdate';
  const AUTO_UPDATE_INTERVAL_MINUTES = 12 * 60;
  const WATCHDOG_INTERVAL_MINUTES = 60;
  const STARTUP_DELAY_MINUTES = 1;
  const RETRY_BASE_MINUTES = 15;
  const RETRY_MAX_MINUTES = 3 * 60;
  const MIN_INTERVAL_MINUTES = 1;
  const MAX_INTERVAL_MINUTES = 24 * 60;
  const RUNNING_LOCK_TIMEOUT_MS = 15 * 60 * 1000;

  let inFlightPromise = null;

  function createError(code, message, details) {

    return {
      code,
      message,
      details: details === undefined ? null : details,
    };

  }

  function normalizeError(error, fallbackCode, fallbackMessage) {

    if (error && error.code && error.message) {
      return {
        code: error.code,
        message: error.message,
        details: error.details === undefined ? null : error.details,
      };
    }
    return createError(
        fallbackCode,
        error && error.message ? error.message : fallbackMessage,
    );

  }

  function validateInterval(intervalMinutes) {

    const parsed = Number(intervalMinutes);
    if (
      !Number.isFinite(parsed) ||
      parsed < MIN_INTERVAL_MINUTES ||
      parsed > MAX_INTERVAL_MINUTES
    ) {
      throw new TypeError(
          `intervalMinutes must be between ${MIN_INTERVAL_MINUTES} and ` +
          `${MAX_INTERVAL_MINUTES}.`,
      );
    }
    return Math.round(parsed);

  }

  function getNextRunAt(intervalMinutes, now = Date.now()) {

    return now + validateInterval(intervalMinutes) * 60 * 1000;

  }

  function getDueAt(periodicUpdate, providerKey) {

    if (
      !periodicUpdate ||
      !providerKey ||
      !periodicUpdate.lastSuccessfulUpdateAt ||
      periodicUpdate.lastSuccessfulProviderKey !== providerKey
    ) {
      return null;
    }
    return periodicUpdate.lastSuccessfulUpdateAt +
      validateInterval(periodicUpdate.intervalMinutes) * 60 * 1000;

  }

  function isUpdateDue(periodicUpdate, providerKey, now = Date.now()) {

    if (!periodicUpdate || periodicUpdate.enabled !== true || !providerKey) {
      return false;
    }
    const dueAt = getDueAt(periodicUpdate, providerKey);
    return dueAt === null || now >= dueAt;

  }

  function getRetryDelayMinutes(consecutiveFailures) {

    const failures = Math.max(1, Math.floor(Number(consecutiveFailures) || 1));
    return Math.min(
        RETRY_BASE_MINUTES * Math.pow(2, failures - 1),
        RETRY_MAX_MINUTES,
    );

  }

  function hasAlarmApi() {

    return Boolean(
        typeof chrome !== 'undefined' &&
        chrome.alarms &&
        chrome.alarms.create,
    );

  }

  function getAlarm(name) {

    if (!hasAlarmApi()) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      chrome.alarms.get(name, (alarm) => resolve(alarm || null));
    });

  }

  function clearAlarm(name) {

    if (!hasAlarmApi()) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      chrome.alarms.clear(name, (ifCleared) => resolve(Boolean(ifCleared)));
    });

  }

  function clearAllAlarms() {

    return Promise.all([
      clearAlarm(ALARM_NAME),
      clearAlarm(RETRY_ALARM_NAME),
    ]);

  }

  function summarizeAlarm(alarm) {

    if (!alarm) {
      return null;
    }
    return {
      name: alarm.name,
      scheduledTime: alarm.scheduledTime || null,
      periodInMinutes: alarm.periodInMinutes || null,
    };

  }

  async function ensureWatchdogAlarm(options = {}) {

    if (!hasAlarmApi()) {
      return Promise.resolve(null);
    }
    const now = Date.now();
    const delayMinutes = options.startupDelay === true ?
      STARTUP_DELAY_MINUTES :
      WATCHDOG_INTERVAL_MINUTES;
    const latestWhen = now + delayMinutes * 60 * 1000;
    const existing = await getAlarm(ALARM_NAME);
    if (
      existing &&
      existing.periodInMinutes === WATCHDOG_INTERVAL_MINUTES &&
      existing.scheduledTime &&
      existing.scheduledTime <= latestWhen
    ) {
      return summarizeAlarm(existing);
    }
    chrome.alarms.create(ALARM_NAME, {
      when: latestWhen,
      periodInMinutes: WATCHDOG_INTERVAL_MINUTES,
    });
    return {
      name: ALARM_NAME,
      scheduledTime: latestWhen,
      periodInMinutes: WATCHDOG_INTERVAL_MINUTES,
    };

  }

  async function scheduleDueCheck(delayMinutes = STARTUP_DELAY_MINUTES) {

    if (!hasAlarmApi()) {
      return null;
    }
    const delay = validateInterval(delayMinutes);
    const when = Date.now() + delay * 60 * 1000;
    const existing = await getAlarm(RETRY_ALARM_NAME);
    if (existing && existing.scheduledTime && existing.scheduledTime <= when) {
      return summarizeAlarm(existing);
    }
    chrome.alarms.create(RETRY_ALARM_NAME, {when});
    return {
      name: RETRY_ALARM_NAME,
      scheduledTime: when,
      periodInMinutes: null,
    };

  }

  async function scheduleRetry(consecutiveFailures) {

    return scheduleDueCheck(getRetryDelayMinutes(consecutiveFailures));

  }

  async function updateNextRunState(state, status, fallbackNextRunAt) {

    const dueAt = getDueAt(
        state.periodicUpdate,
        state.currentPacProviderKey,
    );
    const nextStatus = status || state.periodicUpdate.status;
    const nextRunAt = dueAt || fallbackNextRunAt || null;
    if (
      state.periodicUpdate.status === nextStatus &&
      state.periodicUpdate.nextRunAt === nextRunAt
    ) {
      return state.periodicUpdate;
    }
    return mv3State.setPeriodicUpdateState({
      status: nextStatus,
      nextRunAt,
    });

  }

  async function reconcileAlarms(options = {}) {

    const state = await mv3State.loadState();
    const periodicUpdate = state.periodicUpdate;
    if (!periodicUpdate.enabled) {
      await clearAllAlarms();
      return mv3State.setPeriodicUpdateState({
        status: periodicUpdate.status === 'running' ? 'skipped' : 'idle',
        nextRunAt: null,
      });
    }
    await ensureWatchdogAlarm(options);
    let dueCheck = null;
    if (isUpdateDue(periodicUpdate, state.currentPacProviderKey)) {
      dueCheck = await scheduleDueCheck(STARTUP_DELAY_MINUTES);
    }
    return updateNextRunState(
        state,
        'scheduled',
        dueCheck && dueCheck.scheduledTime,
    );

  }

  async function getStatus(stateSnapshot) {

    const state = stateSnapshot || await mv3State.loadState();
    return {
      periodicUpdate: state.periodicUpdate,
      alarms: {
        periodicUpdate: summarizeAlarm(await getAlarm(ALARM_NAME)),
        retryUpdate: summarizeAlarm(await getAlarm(RETRY_ALARM_NAME)),
      },
      constants: {
        alarmName: ALARM_NAME,
        retryAlarmName: RETRY_ALARM_NAME,
        autoUpdateIntervalMinutes: AUTO_UPDATE_INTERVAL_MINUTES,
        watchdogIntervalMinutes: WATCHDOG_INTERVAL_MINUTES,
        startupDelayMinutes: STARTUP_DELAY_MINUTES,
        minIntervalMinutes: MIN_INTERVAL_MINUTES,
        maxIntervalMinutes: MAX_INTERVAL_MINUTES,
      },
    };

  }

  async function setEnabled(enabled) {

    if (typeof enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean.');
    }
    await mv3State.setPeriodicUpdateEnabled(enabled);
    if (!enabled) {
      await clearAllAlarms();
      await mv3State.setPeriodicUpdateState({
        status: 'idle',
        nextRunAt: null,
      });
      return getStatus();
    }
    await ensureWatchdogAlarm({startupDelay: true});
    const dueCheck = await scheduleDueCheck(STARTUP_DELAY_MINUTES);
    await updateNextRunState(
        await mv3State.loadState(),
        'scheduled',
        dueCheck && dueCheck.scheduledTime,
    );
    return getStatus();

  }

  async function setIntervalMinutes(intervalMinutes) {

    const normalizedInterval = validateInterval(intervalMinutes);
    const periodicUpdate = await mv3State.setPeriodicUpdateInterval(
        normalizedInterval,
    );
    if (periodicUpdate.enabled) {
      await ensureWatchdogAlarm();
      await updateNextRunState(await mv3State.loadState(), 'scheduled');
    }
    return getStatus();

  }

  function isRunningFresh(periodicUpdate, now = Date.now()) {

    return periodicUpdate.status === 'running' &&
      periodicUpdate.lastStartedAt &&
      now - periodicUpdate.lastStartedAt < RUNNING_LOCK_TIMEOUT_MS;

  }

  function createInProgressResult(trigger) {

    return {
      ok: false,
      status: trigger === 'manual' ? 'error' : 'skipped',
      trigger,
      error: createError(
          'PERIODIC_UPDATE_IN_PROGRESS',
          'Periodic update is already running.',
      ),
    };

  }

  async function runUpdate({trigger = 'manual', applyIfSafe = true, execute}) {

    if (typeof execute !== 'function') {
      throw new TypeError('execute must be a function.');
    }
    if (inFlightPromise) {
      return createInProgressResult(trigger);
    }

    const state = await mv3State.loadState();
    if (isRunningFresh(state.periodicUpdate)) {
      const result = createInProgressResult(trigger);
      await mv3State.recordPeriodicUpdateEvent({
        type: 'in_progress',
        at: Date.now(),
        trigger,
        status: result.status,
        message: result.error.message,
        error: result.error,
      });
      return result;
    }

    inFlightPromise = runUpdateInternal({trigger, applyIfSafe, execute})
        .finally(() => {
          inFlightPromise = null;
        });
    return inFlightPromise;

  }

  async function runUpdateInternal({trigger, applyIfSafe, execute}) {

    const startedAt = Date.now();
    await mv3State.setPeriodicUpdateState({
      status: 'running',
      lastAttemptAt: startedAt,
      lastStartedAt: startedAt,
      lastFinishedAt: null,
      lastError: null,
    });
    await mv3State.recordPeriodicUpdateEvent({
      type: 'started',
      at: startedAt,
      trigger,
      status: 'running',
      message: 'Periodic PAC update started.',
    });

    let result;
    try {
      result = await execute({trigger, applyIfSafe});
    } catch (err) {
      result = {
        ok: false,
        status: 'error',
        error: normalizeError(
            err,
            'PERIODIC_UPDATE_FAILED',
            'Periodic PAC update failed.',
        ),
      };
    }

    const finishedAt = Date.now();
    const state = await mv3State.loadState();
    const ifSkipped = result && result.status === 'skipped';
    const ifSuccess = result && result.ok === true;
    const status = ifSkipped ? 'skipped' : (ifSuccess ? 'success' : 'error');
    const error = ifSuccess || ifSkipped ? null : normalizeError(
        result && result.error,
        'PERIODIC_UPDATE_FAILED',
        'Periodic PAC update failed.',
    );
    const providerKey = result && result.providerKey ||
      state.currentPacProviderKey;
    const patch = {
      status,
      lastFinishedAt: finishedAt,
      lastResult: result || null,
    };
    if (status === 'success') {
      patch.lastSuccessfulUpdateAt =
        result && result.successfulUpdateAt || finishedAt;
      patch.lastSuccessfulProviderKey = providerKey || null;
      patch.lastFailureAt = null;
      patch.lastFailureCode = null;
      patch.lastError = null;
      patch.consecutiveFailures = 0;
      patch.nextRunAt = state.periodicUpdate.enabled ?
        patch.lastSuccessfulUpdateAt +
          state.periodicUpdate.intervalMinutes * 60 * 1000 :
        null;
      await clearAlarm(RETRY_ALARM_NAME);
    } else if (status === 'error') {
      patch.lastFailureAt = finishedAt;
      patch.lastFailureCode = error && error.code || 'PERIODIC_UPDATE_FAILED';
      patch.lastError = error;
      patch.consecutiveFailures =
        state.periodicUpdate.consecutiveFailures + 1;
      const retryDelay = getRetryDelayMinutes(patch.consecutiveFailures);
      patch.nextRunAt = state.periodicUpdate.enabled ?
        finishedAt + retryDelay * 60 * 1000 :
        null;
      if (state.periodicUpdate.enabled) {
        await clearAlarm(RETRY_ALARM_NAME);
        await scheduleRetry(patch.consecutiveFailures);
      }
    } else {
      patch.lastError = state.periodicUpdate.lastError;
      patch.consecutiveFailures = state.periodicUpdate.consecutiveFailures;
      patch.nextRunAt = state.periodicUpdate.enabled ?
        getDueAt(state.periodicUpdate, state.currentPacProviderKey) :
        null;
    }

    await mv3State.setPeriodicUpdateState(patch);
    await mv3State.recordPeriodicUpdateEvent({
      type: status,
      at: finishedAt,
      trigger,
      providerKey: result && result.providerKey,
      status,
      message: getResultMessage(status, result),
      error,
    });
    if (state.periodicUpdate.enabled && hasAlarmApi()) {
      await ensureWatchdogAlarm();
    }
    return Object.assign({}, result, {
      periodicUpdate: await mv3State.getPeriodicUpdateState(),
    });

  }

  function getResultMessage(status, result) {

    if (status === 'success') {
      return result && result.autoApply && result.autoApply.applied ?
        'Periodic PAC update finished and applied.' :
        'Periodic PAC update finished without automatic apply.';
    }
    if (status === 'skipped') {
      return result && result.message || 'Periodic PAC update skipped.';
    }
    return result && result.error && result.error.message ||
      'Periodic PAC update failed.';

  }

  function selfTest() {

    let invalidIntervalRejected = false;
    try {
      validateInterval(0);
    } catch (err) {
      invalidIntervalRejected = err instanceof TypeError;
    }
    return {
      alarmNameStable: ALARM_NAME === 'pac.periodicUpdate',
      retryAlarmNameStable: RETRY_ALARM_NAME === 'pac.retryUpdate',
      defaultIntervalIsTwelveHours:
        AUTO_UPDATE_INTERVAL_MINUTES === 12 * 60,
      watchdogRunsHourly: WATCHDOG_INTERVAL_MINUTES === 60,
      invalidIntervalRejected,
      validIntervalRounded: validateInterval(1.2) === 1,
      nextRunInFuture: getNextRunAt(1, 1000) === 61000,
      missingSuccessIsDue: isUpdateDue({
        enabled: true,
        intervalMinutes: AUTO_UPDATE_INTERVAL_MINUTES,
        lastSuccessfulUpdateAt: null,
        lastSuccessfulProviderKey: null,
      }, 'provider', 1000) === true,
      recentSuccessIsNotDue: isUpdateDue({
        enabled: true,
        intervalMinutes: AUTO_UPDATE_INTERVAL_MINUTES,
        lastSuccessfulUpdateAt: 1000,
        lastSuccessfulProviderKey: 'provider',
      }, 'provider', 1000 + 60 * 60 * 1000) === false,
      oldSuccessIsDue: isUpdateDue({
        enabled: true,
        intervalMinutes: AUTO_UPDATE_INTERVAL_MINUTES,
        lastSuccessfulUpdateAt: 1000,
        lastSuccessfulProviderKey: 'provider',
      }, 'provider', 1000 + 12 * 60 * 60 * 1000) === true,
      disabledUpdateIsNotDue: isUpdateDue({
        enabled: false,
        intervalMinutes: AUTO_UPDATE_INTERVAL_MINUTES,
      }, 'provider', 1000) === false,
      providerChangeIsDue: isUpdateDue({
        enabled: true,
        intervalMinutes: AUTO_UPDATE_INTERVAL_MINUTES,
        lastSuccessfulUpdateAt: 1000,
        lastSuccessfulProviderKey: 'other-provider',
      }, 'provider', 1001) === true,
      retryBackoffBounded:
        getRetryDelayMinutes(1) === 15 &&
        getRetryDelayMinutes(2) === 30 &&
        getRetryDelayMinutes(3) === 60 &&
        getRetryDelayMinutes(10) === 180,
      freshRunningDetected: isRunningFresh({
        status: 'running',
        lastStartedAt: Date.now(),
      }) === true,
      staleRunningIgnored: isRunningFresh({
        status: 'running',
        lastStartedAt: Date.now() - RUNNING_LOCK_TIMEOUT_MS - 1,
      }) === false,
    };

  }

  function isUpdateInFlight() {

    return Boolean(inFlightPromise);

  }

  exports.mv3PeriodicUpdate = Object.freeze({
    ALARM_NAME,
    RETRY_ALARM_NAME,
    AUTO_UPDATE_INTERVAL_MINUTES,
    WATCHDOG_INTERVAL_MINUTES,
    STARTUP_DELAY_MINUTES,
    RETRY_BASE_MINUTES,
    RETRY_MAX_MINUTES,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
    RUNNING_LOCK_TIMEOUT_MS,
    validateInterval,
    getDueAt,
    isUpdateDue,
    getRetryDelayMinutes,
    reconcileAlarms,
    scheduleDueCheck,
    scheduleRetry,
    getStatus,
    setEnabled,
    setIntervalMinutes,
    runUpdate,
    isUpdateInFlight,
    selfTest,
  });

})(self);
