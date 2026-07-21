'use strict';

/* global mv3LegacyMigrationAudit, mv3PacMods, mv3State */

(function(exports) {

  const STRATEGIES = Object.freeze([
    'fillMissing',
    'overwriteSelected',
  ]);
  const ALLOWED_FIELDS = Object.freeze([
    'currentPacProviderKey',
    'pacUpdatePeriodInMinutes',
    'pacMods',
    'notificationPrefs',
  ]);
  const DEFAULT_VALUES = Object.freeze({
    currentPacProviderKey: null,
    pacUpdatePeriodInMinutes: 12,
    pacMods: mv3PacMods.DEFAULT_PAC_MODS,
    notificationPrefs: Object.freeze({
      pacError: true,
      extError: true,
      noControl: true,
    }),
  });

  function isObject(value) {

    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  }

  function clone(value) {

    return JSON.parse(JSON.stringify(value));

  }

  function valuesEqual(left, right) {

    return JSON.stringify(left) === JSON.stringify(right);

  }

  function sanitizeValue(value) {

    if (
      typeof mv3LegacyMigrationAudit !== 'undefined' &&
      mv3LegacyMigrationAudit.sanitizeValue
    ) {
      return mv3LegacyMigrationAudit.sanitizeValue(value);
    }
    return value;

  }

  function createError(code, message, details) {

    return {
      code,
      message,
      details: details === undefined ? null : details,
    };

  }

  function createFailure(code, message, details) {

    return {
      ok: false,
      status: 'error',
      error: createError(code, message, details),
    };

  }

  function normalizeStrategy(strategy) {

    return STRATEGIES.includes(strategy) ? strategy : null;

  }

  function normalizeFields(fields) {

    if (!Array.isArray(fields)) {
      return null;
    }
    return Array.from(new Set(fields.filter((field) => typeof field === 'string')));

  }

  function validateRequest(params) {

    const strategy = normalizeStrategy(params.strategy);
    if (!strategy) {
      return createFailure(
          'VALIDATION_ERROR',
          'strategy must be fillMissing or overwriteSelected.',
      );
    }
    const fields = normalizeFields(params.fields);
    if (!fields || !fields.length) {
      return createFailure(
          'NO_MIGRATABLE_FIELDS',
          'Select at least one migration field.',
      );
    }
    const invalidFields = fields.filter((field) => !ALLOWED_FIELDS.includes(field));
    if (invalidFields.length) {
      return createFailure(
          'INVALID_FIELD',
          'Migration request contains unsupported fields.',
          {invalidFields},
      );
    }
    return {
      ok: true,
      strategy,
      fields,
    };

  }

  function getPlanMigration(plan) {

    return plan && plan.proposedMigration || {};

  }

  function getTargetValues(plan) {

    const proposed = getPlanMigration(plan);
    return isObject(proposed.applyValues) ?
      proposed.applyValues :
      (isObject(proposed.canMigrate) ? proposed.canMigrate : {});

  }

  function hasTargetValue(targets, field) {

    return targets[field] !== null && targets[field] !== undefined;

  }

  function isDefaultFieldValue(field, value) {

    return valuesEqual(value, DEFAULT_VALUES[field]);

  }

  function createConflict(field, currentValue, legacyValue, strategy) {

    return {
      field,
      reason: strategy === 'overwriteSelected' ?
        'Selected overwrite strategy will replace a non-default MV3 value.' :
        'MV3 already has a non-default value that differs from legacy data.',
      currentSummary: sanitizeValue(currentValue),
      legacySummary: sanitizeValue(legacyValue),
    };

  }

  function addCannotMigrateSkips(skippedFields, cannotMigrate) {

    if (!Array.isArray(cannotMigrate)) {
      return;
    }
    cannotMigrate.forEach((item) => {
      skippedFields.push({
        field: item.key || item.field || 'legacy-data',
        reason: item.reason || 'Legacy setting is not supported by MV3 migration.',
        source: item.source || null,
      });
    });

  }

  function createApplyPlan({plan, currentState, strategy, fields}) {

    const request = validateRequest({strategy, fields});
    if (request.ok === false) {
      return request;
    }
    if (!plan || plan.detected !== true) {
      return createFailure(
          'NO_LEGACY_DATA',
          'No legacy MV2 data was detected.',
      );
    }

    const proposed = getPlanMigration(plan);
    const targets = getTargetValues(plan);
    const selectedFields = request.fields;
    const patch = {};
    const appliedFields = [];
    const skippedFields = [];
    const conflicts = [];
    const warnings = Array.isArray(proposed.warnings) ?
      proposed.warnings.slice() :
      [];

    addCannotMigrateSkips(skippedFields, proposed.cannotMigrate);

    ALLOWED_FIELDS.forEach((field) => {
      if (!selectedFields.includes(field)) {
        if (hasTargetValue(targets, field)) {
          skippedFields.push({
            field,
            reason: 'Field was not selected.',
          });
        }
        return;
      }

      if (!hasTargetValue(targets, field)) {
        skippedFields.push({
          field,
          reason: 'No migratable legacy value was found for this field.',
        });
        return;
      }

      const legacyValue = targets[field];
      const currentValue = currentState[field];
      const ifConflict = !isDefaultFieldValue(field, currentValue) &&
        !valuesEqual(currentValue, legacyValue);
      if (ifConflict) {
        conflicts.push(createConflict(field, currentValue, legacyValue, strategy));
      }

      if (strategy === 'fillMissing' && ifConflict) {
        skippedFields.push({
          field,
          reason: 'Skipped by fillMissing because MV3 already has a value.',
        });
        return;
      }

      if (valuesEqual(currentValue, legacyValue)) {
        skippedFields.push({
          field,
          reason: 'MV3 already matches the legacy value.',
        });
        return;
      }

      patch[field] = clone(legacyValue);
      appliedFields.push(field);
    });

    if (!appliedFields.length && !skippedFields.length) {
      return createFailure(
          'NO_MIGRATABLE_FIELDS',
          'No selected legacy fields can be migrated.',
      );
    }

    const status = skippedFields.length || conflicts.length ? 'partial' : 'success';
    return {
      ok: true,
      status,
      strategy,
      appliedFields,
      skippedFields: skippedFields.map(sanitizeValue),
      conflicts: conflicts.map(sanitizeValue),
      warnings: warnings.map(String),
      patch,
    };

  }

  function summarizeApplyResult(result) {

    return {
      status: result.status,
      strategy: result.strategy || null,
      appliedFields: result.appliedFields || [],
      skippedFields: result.skippedFields || [],
      conflicts: result.conflicts || [],
      warnings: result.warnings || [],
    };

  }

  async function persistApplyFailure(error) {

    await mv3State.setLegacyMigrationState({
      applyStatus: 'error',
      lastApplyAt: Date.now(),
      lastError: error,
      lastApplySummary: null,
    });

  }

  async function applyLegacyMigration(params = {}) {

    const startedAt = Date.now();
    await mv3State.setLegacyMigrationState({
      applyStatus: 'running',
      lastApplyAt: startedAt,
      lastError: null,
    });

    let plan;
    let result;
    try {
      const auditState = await mv3State.loadState();
      plan = await mv3LegacyMigrationAudit.runAudit({
        includeValues: false,
        includeSensitiveValues: true,
        currentState: auditState,
      });
      let summary;
      await mv3State.updateStateAtomically((currentState) => {
        result = createApplyPlan({
          plan,
          currentState,
          strategy: params.strategy,
          fields: params.fields,
        });
        if (result.ok === false) {
          return {
            legacyMigration: {
              applyStatus: 'error',
              lastApplyAt: Date.now(),
              lastError: result.error,
              lastApplySummary: null,
            },
          };
        }
        summary = summarizeApplyResult(result);
        return Object.assign({}, result.patch, {
          legacyMigration: {
            applyStatus: result.status,
            lastApplyAt: Date.now(),
            detectedLegacyData: plan.detected === true,
            applied: result.appliedFields.length > 0,
            appliedFields: result.appliedFields,
            skippedFields: result.skippedFields,
            conflicts: result.conflicts,
            lastApplySummary: summary,
            lastError: null,
            warnings: result.warnings,
          },
        });
      });
      if (result.ok === false) {
        return result;
      }
      return Object.assign({}, summary, {
        ok: true,
      });
    } catch (err) {
      const error = createError(
          err && err.code || 'MIGRATION_APPLY_FAILED',
          err && err.message || 'Legacy migration apply failed.',
          err && err.details === undefined ? null : err && err.details,
      );
      await persistApplyFailure(error);
      return {
        ok: false,
        status: 'error',
        error,
      };
    }

  }

  function selfTest() {

    const samplePassword = ['qa', 'Secret'].join('');
    const currentDefaults = clone(DEFAULT_VALUES);
    const currentModified = Object.assign({}, currentDefaults, {
      currentPacProviderKey: 'onlyOwnSites',
      pacMods: mv3PacMods.normalizePacMods({
        localTor: {enabled: true},
      }),
    });
    const noLegacy = createApplyPlan({
      plan: {detected: false},
      currentState: currentDefaults,
      strategy: 'fillMissing',
      fields: ['currentPacProviderKey'],
    });
    const plan = {
      detected: true,
      proposedMigration: {
        canMigrate: {
          currentPacProviderKey: 'Антизапрет',
          pacUpdatePeriodInMinutes: 720,
          pacMods: mv3PacMods.redactPacMods(mv3PacMods.normalizePacMods({
            exceptions: ['direct.example'],
            whitelist: ['allowed.example'],
            ownProxies: [`HTTPS user:${samplePassword}@proxy.example:8443`],
          })),
          notificationPrefs: {
            pacError: false,
            extError: true,
            noControl: true,
          },
        },
        applyValues: {
          currentPacProviderKey: 'Антизапрет',
          pacUpdatePeriodInMinutes: 720,
          pacMods: mv3PacMods.normalizePacMods({
            exceptions: ['direct.example'],
            whitelist: ['allowed.example'],
            ownProxies: [`HTTPS user:${samplePassword}@proxy.example:8443`],
          }),
          notificationPrefs: {
            pacError: false,
            extError: true,
            noControl: true,
          },
        },
        cannotMigrate: [
          {key: 'ip-to-host', reason: 'Derived cache.'},
        ],
        warnings: ['warning'],
      },
    };
    const fillMissing = createApplyPlan({
      plan,
      currentState: currentModified,
      strategy: 'fillMissing',
      fields: ['currentPacProviderKey', 'pacMods', 'notificationPrefs'],
    });
    const overwrite = createApplyPlan({
      plan,
      currentState: currentModified,
      strategy: 'overwriteSelected',
      fields: ['pacMods'],
    });
    const unselected = createApplyPlan({
      plan,
      currentState: currentDefaults,
      strategy: 'overwriteSelected',
      fields: ['notificationPrefs'],
    });
    const invalid = createApplyPlan({
      plan,
      currentState: currentDefaults,
      strategy: 'overwriteSelected',
      fields: ['proxyApply'],
    });
    const text = JSON.stringify([
      summarizeApplyResult(fillMissing),
      summarizeApplyResult(overwrite),
    ]);
    return {
      noLegacyFails: noLegacy.ok === false &&
        noLegacy.error.code === 'NO_LEGACY_DATA',
      fillMissingSkipsNonDefault:
        !fillMissing.appliedFields.includes('currentPacProviderKey') &&
        !fillMissing.appliedFields.includes('pacMods'),
      fillMissingAppliesDefault:
        fillMissing.appliedFields.includes('notificationPrefs'),
      overwriteSelectedAppliesOnlySelected:
        overwrite.appliedFields.length === 1 &&
        overwrite.appliedFields[0] === 'pacMods' &&
        Object.keys(overwrite.patch).length === 1,
      unselectedFieldsUntouched:
        !Object.prototype.hasOwnProperty.call(unselected.patch, 'pacMods'),
      unsupportedLegacySkipped:
        overwrite.skippedFields.some((field) => field.field === 'ip-to-host'),
      conflictsReported: fillMissing.conflicts.length >= 1,
      passwordsRedactedInSummaries:
        !text.includes(samplePassword) &&
        (text.includes('***') || text.includes('[redacted]')),
      invalidFieldRejected:
        invalid.ok === false && invalid.error.code === 'INVALID_FIELD',
    };

  }

  exports.mv3LegacyMigrationApply = Object.freeze({
    ALLOWED_FIELDS,
    STRATEGIES,
    createApplyPlan,
    applyLegacyMigration,
    selfTest,
  });

})(self);
