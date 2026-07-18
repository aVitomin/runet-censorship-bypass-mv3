'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Mocha = require('mocha');
const {createRuntimeHarness} = require('./runtime-performance-harness');

const REVIEWED_RPC_METHODS = Object.freeze([
  'getState', 'getPacProviders', 'getPacMods', 'setPacMods',
  'getPopupState', 'setCurrentSiteMode', 'updatePopupDraft',
  'applyPopupChanges', 'openOptionsPage', 'normalizePacMods',
  'validatePacMods', 'getNotificationPrefs', 'setNotificationPrefs',
  'setCurrentPacProvider', 'addCustomPacProvider',
  'updateCustomPacProvider', 'deleteCustomPacProvider', 'setUiLanguage',
  'resetMv3State', 'downloadPac', 'getPacDownloadState', 'getPacCache',
  'clearPacCache', 'cookPac', 'getPacCookState', 'getCookedPacCache',
  'clearCookedPacCache', 'getProxyStatus', 'getProxyHealth',
  'checkProxyHealth', 'refreshProxyControl', 'applyCookedPac', 'clearProxy',
  'getProxyAuthStatus', 'setProxyAuthEnabled', 'clearProxyAuthEvents',
  'testProxyAuthConfig', 'getPeriodicUpdateStatus',
  'setPeriodicUpdateEnabled', 'setPeriodicUpdateInterval',
  'runPeriodicUpdateNow', 'clearPeriodicUpdateEvents',
  'runLegacyMigrationAudit', 'getLegacyMigrationAuditStatus',
  'getLegacyMigrationPlan', 'clearLegacyMigrationAudit',
  'applyLegacyMigration', 'getLegacyMigrationApplyStatus', 'getPageStatus',
]);

function createCredentialPacMods(secret, overrides = {}) {

  return {
    ownProxies: [Object.assign({
      enabled: true,
      type: 'HTTPS',
      host: 'proxy.example',
      port: 8443,
      username: 'rpc-user',
      password: secret,
      useAsDirectReplacement: false,
      note: 'RPC credential regression fixture',
    }, overrides)],
  };

}

function hasObjectKey(value, searchedKey, seen = new Set()) {

  if (!value || typeof value !== 'object' || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, searchedKey)) {
    return true;
  }
  return Object.keys(value).some((key) =>
    hasObjectKey(value[key], searchedKey, seen),
  );

}

function getExposureFlags(value, secrets) {

  const serialized = JSON.stringify(value);
  return {
    containsSecret: secrets.some((secret) => serialized.includes(secret)),
    containsPasswordField: hasObjectKey(value, 'password'),
  };

}

function clone(value) {

  return JSON.parse(JSON.stringify(value));

}

function setExplicitPassword(proxy, password) {

  proxy.password = password;
  delete proxy.credentialRef;
  delete proxy.hasCredentials;
  delete proxy.hasPassword;

}

function lookupProxyAuth(harness, state, requestId, host, port) {

  harness.context.mv3ProxyAuth.clearProxyAuthAttempts();
  return harness.context.mv3ProxyAuth.handleProxyAuthRequired({
    isProxy: true,
    requestId,
    challenger: {host, port},
  }, state).response;

}

function expectNoCredentialExposure(value, secrets) {

  Chai.expect(getExposureFlags(value, secrets)).to.deep.equal({
    containsSecret: false,
    containsPasswordField: false,
  });

}

function expectChecks(checks) {

  Chai.expect(
      Object.keys(checks).filter((key) => checks[key] !== true),
  ).to.deep.equal([]);

}

async function seedCredentialState(harness, secret, overrides = {}) {

  await harness.context.mv3State.savePacMods(
      createCredentialPacMods(secret, overrides),
  );

}

Mocha.describe('MV3 RPC credential redaction', function() {

  Mocha.it('keeps the reviewed RPC exposure inventory explicit',
      async function() {

        const harness = await createRuntimeHarness();
        Chai.expect(Object.keys(harness.audit.RPC_METHODS))
            .to.deep.equal(REVIEWED_RPC_METHODS);

      });

  Mocha.it('sanitizes every PAC-mods response model used by extension pages',
      async function() {

        const secret = ['rpc', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, secret);

        const settings = await harness.callRpc('getState');
        const popup = await harness.callRpc('getPopupState', {
          tabUrl: 'https://audit.example/',
        });
        const pacMods = await harness.callRpc('getPacMods');
        const normalized = await harness.callRpc('normalizePacMods', {
          pacMods: createCredentialPacMods(secret),
        });
        const validated = await harness.callRpc('validatePacMods', {
          pacMods: createCredentialPacMods(secret),
        });
        const saved = await harness.callRpc('setPacMods', {
          pacMods: createCredentialPacMods(secret),
        });
        const providerChanged = await harness.callRpc('setCurrentPacProvider', {
          providerKey: 'Антизапрет',
        });
        const languageChanged = await harness.callRpc('setUiLanguage', {
          language: 'en',
        });
        const proxyAuthStatus = await harness.callRpc('getProxyAuthStatus');
        const proxyAuthConfig = await harness.callRpc('testProxyAuthConfig');
        const pacDownloadState = await harness.callRpc('getPacDownloadState');
        const pacCache = await harness.callRpc('getPacCache');
        const pacCookState = await harness.callRpc('getPacCookState');
        const cookedPacCache = await harness.callRpc('getCookedPacCache');
        const proxyStatus = await harness.callRpc('getProxyStatus');
        const proxyHealth = await harness.callRpc('getProxyHealth');
        const periodicUpdate = await harness.callRpc('getPeriodicUpdateStatus');
        const migrationAudit = await harness.callRpc(
            'getLegacyMigrationAuditStatus',
        );
        const migrationApply = await harness.callRpc(
            'getLegacyMigrationApplyStatus',
        );
        const pageStatus = await harness.callRpc('getPageStatus', {
          page: 'help',
        });
        const responses = [
          settings,
          popup,
          pacMods,
          normalized,
          validated,
          saved,
          providerChanged,
          languageChanged,
          proxyAuthStatus,
          proxyAuthConfig,
          pacDownloadState,
          pacCache,
          pacCookState,
          cookedPacCache,
          proxyStatus,
          proxyHealth,
          periodicUpdate,
          migrationAudit,
          migrationApply,
          pageStatus,
        ];
        responses.forEach((response) =>
          expectNoCredentialExposure(response, [secret]),
        );

        const proxy = settings.state.pacMods.ownProxies[0];
        const compatibilityFlags = {
          popupHasCandidateCounts:
            typeof popup.quickProxies.ownProxyCount === 'number' &&
            popup.proxyCandidates.available === true,
          settingsKeepsUsername: proxy.username === 'rpc-user',
          settingsKeepsEndpoint:
            proxy.type === 'HTTPS' &&
            proxy.host === 'proxy.example' &&
            proxy.port === 8443,
          settingsKeepsEditableFields:
            proxy.enabled === true &&
            proxy.useAsDirectReplacement === false &&
            proxy.note === 'RPC credential regression fixture',
          settingsDescribesCredentials:
            proxy.hasCredentials === true && proxy.hasPassword === true,
          settingsHasNonSecretCredentialRef:
            proxy.credentialRef &&
            proxy.credentialRef.index === 0 &&
            Object.keys(proxy.credentialRef).sort().join(',') ===
              'host,index,port,revision,type,username' &&
            proxy.credentialRef.revision ===
              settings.state.pacMods.credentialRevision &&
            !hasObjectKey(proxy.credentialRef, 'password') &&
            !JSON.stringify(proxy.credentialRef).includes(secret),
          settingsUsesExplicitMinimumStateModel:
            Object.keys(settings.state).sort().join(',') === [
              'cookedPacCache',
              'currentPacProviderKey',
              'legacyMigration',
              'notificationPrefs',
              'pacCache',
              'pacCook',
              'pacDownload',
              'pacMods',
              'proxyApply',
              'proxyControl',
              'uiLanguage',
            ].join(','),
          passwordDerivedPacModsHashesStayInternal:
            responses.every((response) =>
              !hasObjectKey(response, 'pacModsSha256') &&
              !hasObjectKey(response, 'currentPacModsSha256'),
            ),
          validatedKeepsPacFields:
            validated.ok === true &&
            validated.pacMods.usePacScriptProxies === true &&
            validated.pacMods.ownProxies[0].hasPassword === true,
          setterResponsesKeepRequiredFields:
            saved.ok === true &&
            providerChanged.currentPacProviderKey === 'Антизапрет' &&
            languageChanged.ok === true &&
            languageChanged.uiLanguage === 'en',
          placeholderReceivesStatusOnly:
            typeof pageStatus.backgroundStatus === 'string' &&
            typeof pageStatus.pacStatus === 'string' &&
            !Object.prototype.hasOwnProperty.call(pageStatus, 'state'),
        };
        expectChecks(compatibilityFlags);

      });

  Mocha.it('keeps PAC fingerprints independent of authentication data',
      async function() {

        const firstSecret = ['hash', 'first', 'fixture'].join('-');
        const secondSecret = ['hash', 'second', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        const first = createCredentialPacMods(firstSecret);
        const second = createCredentialPacMods(secondSecret, {
          username: 'different-user',
        });
        const endpointChange = createCredentialPacMods(secondSecret, {
          host: 'different-proxy.example',
        });
        const passwordRemoved = createCredentialPacMods('');

        const firstHash = await harness.context.mv3PacCook.hashPacMods(first);
        const secondHash = await harness.context.mv3PacCook.hashPacMods(second);
        const endpointHash = await harness.context.mv3PacCook.hashPacMods(
            endpointChange,
        );
        const passwordlessHash = await harness.context.mv3PacCook.hashPacMods(
            passwordRemoved,
        );

        expectChecks({
          passwordAndUsernameDoNotAffectPacFingerprint:
            firstHash === secondHash,
          routingEndpointStillAffectsPacFingerprint:
            firstHash !== endpointHash,
          passwordPresenceStillRefreshesCookWarnings:
            firstHash !== passwordlessHash,
          fingerprintDoesNotContainCredentials:
            ![firstHash, secondHash, endpointHash, passwordlessHash].some((hash) =>
              hash.includes(firstSecret) || hash.includes(secondSecret),
            ),
        });

      });

  Mocha.it('sanitizes credential URLs, proxy strings, and RPC errors',
      async function() {

        const secret = ['error', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        const credentialUrl = [
          'https://rpc-user:',
          secret,
          '@pac.example/proxy.pac?token=private',
        ].join('');
        const proxyString = `HTTPS rpc-user:${secret}@proxy.example:8443`;
        const rejectedProvider = await harness.callRpcRaw(
            'addCustomPacProvider',
            {label: 'Rejected provider', urls: [credentialUrl]},
        );
        const syntheticError = harness.audit.createErrorResponse({
          code: 'SYNTHETIC_CREDENTIAL_ERROR',
          message:
            `Rejected ${credentialUrl} via ${proxyString}; password=${secret}`,
          details: {
            password: secret,
            proxyPassword: secret,
            url: credentialUrl,
            proxy: proxyString,
            authCredentials: {
              username: 'rpc-user',
              password: secret,
            },
            metadata: [{
              ownProxies: [{
                username: 'rpc-user',
                password: secret,
                url: credentialUrl,
              }],
            }],
          },
        });
        const sanitizedError = harness.context.mv3State.sanitizeRpcValue(
            syntheticError,
        );

        expectNoCredentialExposure(rejectedProvider, [secret]);
        expectNoCredentialExposure(sanitizedError, [secret]);
        expectChecks({
          providerRejected: rejectedProvider.ok === false,
          urlAuthorityRedacted:
            sanitizedError.error.message.includes('https://***@pac.example/'),
          proxyAuthorityRedacted:
            sanitizedError.error.message.includes('HTTPS ***@proxy.example:8443'),
          namedPasswordRedacted:
            sanitizedError.error.message.includes('password=***'),
          authCredentialsReduced:
            sanitizedError.error.details.authCredentials.hasCredentials === true,
          nestedPasswordFieldsRemoved:
            !Object.prototype.hasOwnProperty.call(
                sanitizedError.error.details,
                'proxyPassword',
            ),
        });

      });

  Mocha.it('does not mutate durable credentials when pages only open',
      async function() {

        const secret = ['open', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, secret);
        const before = harness.getState().pacMods;
        harness.resetCounts();

        const settings = await harness.callRpc('getState');
        await harness.callRpc('getPopupState', {
          tabUrl: 'https://audit.example/',
        });
        settings.state.pacMods.ownProxies[0].username = 'page-only-mutation';
        settings.state.pacMods.ownProxies[0].credentialRef.username =
          'page-only-ref-mutation';
        settings.state.pacMods.noDirect = !settings.state.pacMods.noDirect;

        const after = harness.getState().pacMods;
        expectChecks({
          openingLeavesStateEqual:
            JSON.stringify(after) === JSON.stringify(before),
          openingPerformsNoStorageWrite: harness.counts.storageSets === 0,
          durablePasswordUnchanged:
            after.ownProxies[0].password === secret,
          returnedObjectDoesNotShareProxy:
            after.ownProxies[0].username === 'rpc-user',
          returnedObjectDoesNotSharePacMods:
            after.noDirect === before.noDirect,
        });

      });

  Mocha.it('preserves, replaces, and removes credentials explicitly',
      async function() {

        const originalSecret = ['original', 'credential', 'fixture'].join('-');
        const replacementSecret = ['replacement', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, originalSecret);
        await harness.callRpc('setUiLanguage', {language: 'en'});
        const afterLanguage = harness.getState().pacMods.ownProxies[0];

        const unrelated = await harness.callRpc('getPacMods');
        unrelated.noDirect = true;
        const unrelatedResponse = await harness.callRpc('setPacMods', {
          pacMods: unrelated,
        });
        const afterUnrelatedState = harness.getState();
        const afterUnrelated = afterUnrelatedState.pacMods.ownProxies[0];
        const authAfterUnrelated = lookupProxyAuth(
            harness,
            afterUnrelatedState,
            'preserved-unrelated',
            'proxy.example',
            8443,
        );

        const usernameEdit = await harness.callRpc('getPacMods');
        usernameEdit.ownProxies[0].username = 'updated-rpc-user';
        usernameEdit.ownProxies[0].password =
          harness.context.mv3PacMods.REDACTED_PASSWORD;
        const usernameResponse = await harness.callRpc('setPacMods', {
          pacMods: usernameEdit,
        });
        const afterUsernameState = harness.getState();
        const afterUsername = afterUsernameState.pacMods.ownProxies[0];
        const authAfterUsername = lookupProxyAuth(
            harness,
            afterUsernameState,
            'preserved-username',
            'proxy.example',
            8443,
        );

        const replacement = await harness.callRpc('getPacMods');
        setExplicitPassword(replacement.ownProxies[0], replacementSecret);
        const replacementResponse = await harness.callRpc('setPacMods', {
          pacMods: replacement,
        });
        const afterReplacementState = harness.getState();
        const afterReplacement = afterReplacementState.pacMods.ownProxies[0];
        const authAfterReplacement = lookupProxyAuth(
            harness,
            afterReplacementState,
            'replaced-password',
            'proxy.example',
            8443,
        );

        const removal = await harness.callRpc('getPacMods');
        removal.ownProxies[0].username = '';
        setExplicitPassword(removal.ownProxies[0], '');
        const removalResponse = await harness.callRpc('setPacMods', {
          pacMods: removal,
        });
        const afterRemovalState = harness.getState();
        const afterRemoval = afterRemovalState.pacMods.ownProxies[0];
        const authAfterRemoval = harness.context.mv3ProxyAuth
            .buildProxyAuthConfig(afterRemovalState);
        const authLookupAfterRemoval = lookupProxyAuth(
            harness,
            afterRemovalState,
            'removed-password',
            'proxy.example',
            8443,
        );
        const passwordlessModel = await harness.callRpc('getPacMods');
        passwordlessModel.noDirect = !passwordlessModel.noDirect;
        const passwordlessSaveResponse = await harness.callRpc('setPacMods', {
          pacMods: passwordlessModel,
        });
        const afterPasswordlessSave = harness.getState().pacMods.ownProxies[0];

        [
          unrelatedResponse,
          usernameResponse,
          replacementResponse,
          removalResponse,
          passwordlessSaveResponse,
        ].forEach((response) =>
          expectNoCredentialExposure(
              response,
              [originalSecret, replacementSecret],
          ),
        );
        expectChecks({
          unrelatedStateSavePreservesPassword:
            afterLanguage.password === originalSecret,
          unrelatedSavePreservesPassword:
            afterUnrelated.password === originalSecret &&
            authAfterUnrelated.authCredentials.password === originalSecret,
          responseMetadataNotPersisted:
            !Object.prototype.hasOwnProperty.call(
                afterUnrelated,
                'credentialRef',
            ) &&
            !Object.prototype.hasOwnProperty.call(afterUnrelated, 'hasPassword') &&
            !Object.prototype.hasOwnProperty.call(
                afterUnrelated,
                'hasCredentials',
            ) &&
            !Object.prototype.hasOwnProperty.call(
                afterUnrelatedState.pacMods,
                'credentialRevision',
            ),
          usernameEditPreservesPassword:
            afterUsername.username === 'updated-rpc-user' &&
            afterUsername.password === originalSecret &&
            authAfterUsername.authCredentials.username === 'updated-rpc-user' &&
            authAfterUsername.authCredentials.password === originalSecret,
          replacementStored:
            afterReplacement.password === replacementSecret &&
            authAfterReplacement.authCredentials.password === replacementSecret,
          removalStored:
            afterRemoval.username === '' && afterRemoval.password === '',
          removalDisablesAuthCredential:
            authAfterRemoval.credentialCount === 0 &&
            !Object.prototype.hasOwnProperty.call(
                authLookupAfterRemoval,
                'authCredentials',
            ),
          versionedPasswordlessRowRemainsPasswordless:
            passwordlessModel.ownProxies[0].hasPassword === false &&
            Boolean(passwordlessModel.ownProxies[0].credentialRef) &&
            afterPasswordlessSave.password === '',
        });

      });

  Mocha.it('keeps original credentials available only to proxy authentication',
      async function() {

        const secret = ['auth', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, secret);
        await harness.callRpc('getState');
        await harness.callRpc('getPopupState', {
          tabUrl: 'https://audit.example/',
        });

        harness.context.mv3ProxyAuth.clearProxyAuthAttempts();
        const result = harness.context.mv3ProxyAuth.handleProxyAuthRequired({
          isProxy: true,
          requestId: 'rpc-credential-test',
          challenger: {host: 'proxy.example', port: 8443},
        }, harness.getState());
        const pacCandidate = harness.context.mv3PacMods.proxyEntryToPacString(
            harness.getState().pacMods.ownProxies[0],
        );
        expectChecks({
          authReceivesUsername:
            result.response.authCredentials.username === 'rpc-user',
          authReceivesPassword:
            result.response.authCredentials.password === secret,
          authEventOmitsPassword:
            !JSON.stringify(result.event).includes(secret) &&
            !hasObjectKey(result.event, 'password'),
          pacCandidateOmitsCredentials:
            !pacCandidate.includes(secret) &&
            !pacCandidate.includes('rpc-user'),
        });

      });

  Mocha.it('keeps redacted credentials attached to their original proxy rows',
      async function() {

        const firstSecret = ['first', 'credential', 'fixture'].join('-');
        const secondSecret = ['second', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await harness.context.mv3State.savePacMods({
          ownProxies: [
            createCredentialPacMods(firstSecret, {
              username: 'first-user',
            }).ownProxies[0],
            createCredentialPacMods(secondSecret, {
              username: 'second-user',
            }).ownProxies[0],
          ],
        });

        const reordered = await harness.callRpc('getPacMods');
        reordered.ownProxies.reverse();
        const response = await harness.callRpc('setPacMods', {
          pacMods: reordered,
        });
        const stored = harness.getState().pacMods.ownProxies;

        expectNoCredentialExposure(response, [firstSecret, secondSecret]);
        expectChecks({
          secondRowMovedWithPassword:
            stored[0].username === 'second-user' &&
            stored[0].password === secondSecret,
          firstRowMovedWithPassword:
            stored[1].username === 'first-user' &&
            stored[1].password === firstSecret,
        });

      });

  Mocha.it('rejects cross-row and repeated credential references',
      async function() {

        const firstSecret = ['cross', 'first', 'fixture'].join('-');
        const secondSecret = ['cross', 'second', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await harness.context.mv3State.savePacMods({
          ownProxies: [
            createCredentialPacMods(firstSecret, {
              username: 'first-user',
            }).ownProxies[0],
            createCredentialPacMods(secondSecret, {
              username: 'second-user',
            }).ownProxies[0],
          ],
        });
        const model = await harness.callRpc('getPacMods');
        const swappedReferences = clone(model);
        const firstRef = clone(swappedReferences.ownProxies[0].credentialRef);
        swappedReferences.ownProxies[0].credentialRef = clone(
            swappedReferences.ownProxies[1].credentialRef,
        );
        swappedReferences.ownProxies[1].credentialRef = firstRef;
        const crossRowResponse = await harness.callRpcRaw('setPacMods', {
          pacMods: swappedReferences,
        });

        const repeatedReference = clone(model);
        repeatedReference.ownProxies[1].credentialRef = clone(
            repeatedReference.ownProxies[0].credentialRef,
        );
        const replayResponse = await harness.callRpcRaw('setPacMods', {
          pacMods: repeatedReference,
        });
        const stored = harness.getState().pacMods.ownProxies;

        expectNoCredentialExposure(
            [crossRowResponse, replayResponse],
            [firstSecret, secondSecret],
        );
        expectChecks({
          crossRowRejected:
            crossRowResponse.ok === false &&
            crossRowResponse.error.code === 'INVALID_PARAMS',
          repeatedReferenceRejected:
            replayResponse.ok === false &&
            replayResponse.error.code === 'INVALID_PARAMS',
          credentialsDidNotMove:
            stored[0].password === firstSecret &&
            stored[1].password === secondSecret,
        });

      });

  Mocha.it('rejects reordering credential-bearing duplicate rows',
      async function() {

        const firstSecret = ['duplicate', 'first', 'fixture'].join('-');
        const secondSecret = ['duplicate', 'second', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await harness.context.mv3State.savePacMods({
          ownProxies: [
            createCredentialPacMods(firstSecret, {
              note: 'first duplicate',
            }).ownProxies[0],
            createCredentialPacMods(secondSecret, {
              note: 'second duplicate',
            }).ownProxies[0],
          ],
        });
        const reordered = await harness.callRpc('getPacMods');
        const swappedReferences = clone(reordered);
        const firstReference = clone(
            swappedReferences.ownProxies[0].credentialRef,
        );
        swappedReferences.ownProxies[0].credentialRef = clone(
            swappedReferences.ownProxies[1].credentialRef,
        );
        swappedReferences.ownProxies[1].credentialRef = firstReference;
        const swappedReferenceResponse = await harness.callRpcRaw(
            'setPacMods',
            {pacMods: swappedReferences},
        );
        const partialDuplicate = clone(reordered);
        partialDuplicate.ownProxies = [partialDuplicate.ownProxies[1]];
        const partialDuplicateResponse = await harness.callRpcRaw(
            'setPacMods',
            {pacMods: partialDuplicate},
        );
        reordered.ownProxies.reverse();

        const response = await harness.callRpcRaw('setPacMods', {
          pacMods: reordered,
        });
        const storedState = harness.getState();
        const stored = storedState.pacMods.ownProxies;
        const authConfig = harness.context.mv3ProxyAuth.buildProxyAuthConfig(
            storedState,
        );
        const authCandidates = Object.values(
            authConfig.credentialsByChallenger,
        )[0];

        expectNoCredentialExposure(
            [
              swappedReferenceResponse,
              partialDuplicateResponse,
              response,
            ],
            [firstSecret, secondSecret],
        );
        expectChecks({
          duplicateReferenceSwapRejected:
            swappedReferenceResponse.ok === false &&
            swappedReferenceResponse.error.code === 'INVALID_PARAMS',
          partialDuplicatePreservationRejected:
            partialDuplicateResponse.ok === false &&
            partialDuplicateResponse.error.code === 'INVALID_PARAMS',
          duplicateReorderRejected:
            response.ok === false &&
            response.error.code === 'INVALID_PARAMS',
          firstDuplicateStayedInPlace:
            stored[0].note === 'first duplicate' &&
            stored[0].password === firstSecret,
          secondDuplicateStayedInPlace:
            stored[1].note === 'second duplicate' &&
            stored[1].password === secondSecret,
          duplicateAuthOrderIsDeterministic:
            authCandidates[0].password === firstSecret &&
            authCandidates[1].password === secondSecret,
        });

      });

  Mocha.it('rejects preservation metadata copied to a different proxy endpoint',
      async function() {

        const secret = ['endpoint', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, secret);
        const copiedReference = await harness.callRpc('getPacMods');
        copiedReference.ownProxies[0].host = 'other-proxy.example';

        const response = await harness.callRpcRaw('setPacMods', {
          pacMods: copiedReference,
        });
        const stored = harness.getState().pacMods.ownProxies[0];

        expectNoCredentialExposure(response, [secret]);
        expectChecks({
          copiedReferenceRejected:
            response.ok === false &&
            response.error.code === 'INVALID_PARAMS',
          durableEndpointUnchanged:
            stored.host === 'proxy.example' && stored.password === secret,
        });

      });

  Mocha.it('requires a real password when type, host, or port changes',
      async function() {

        const originalSecret = ['endpoint', 'original', 'fixture'].join('-');
        const replacementSecret = ['endpoint', 'replacement', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, originalSecret);
        const originalModel = await harness.callRpc('getPacMods');
        const credentialBearingRef = clone(originalModel);
        credentialBearingRef.ownProxies[0].credentialRef.password =
          originalSecret;
        const credentialBearingRefResponse = await harness.callRpcRaw(
            'setPacMods',
            {pacMods: credentialBearingRef},
        );
        const edits = [
          ['type', 'SOCKS5'],
          ['host', 'changed-proxy.example'],
          ['port', 9443],
        ];
        const rejected = [];
        for (const [key, value] of edits) {
          const edited = clone(originalModel);
          edited.ownProxies[0][key] = value;
          rejected.push(await harness.callRpcRaw('setPacMods', {
            pacMods: edited,
          }));
        }

        const explicit = clone(originalModel);
        Object.assign(explicit.ownProxies[0], {
          type: 'SOCKS5',
          host: 'changed-proxy.example',
          port: 9443,
        });
        setExplicitPassword(explicit.ownProxies[0], replacementSecret);
        const replacementResponse = await harness.callRpc('setPacMods', {
          pacMods: explicit,
        });
        const replacedState = harness.getState();
        const oldEndpointAuth = lookupProxyAuth(
            harness,
            replacedState,
            'old-endpoint',
            'proxy.example',
            8443,
        );
        const newEndpointAuth = lookupProxyAuth(
            harness,
            replacedState,
            'new-endpoint',
            'changed-proxy.example',
            9443,
        );

        expectNoCredentialExposure(
            [
              credentialBearingRefResponse,
              rejected,
              replacementResponse,
            ],
            [originalSecret, replacementSecret],
        );
        const stored = replacedState.pacMods.ownProxies[0];
        expectChecks({
          redactedEndpointEditsRejected:
            rejected.every((response) =>
              response.ok === false &&
              response.error.code === 'INVALID_PARAMS',
            ),
          credentialBearingReferenceRejected:
            credentialBearingRefResponse.ok === false &&
            credentialBearingRefResponse.error.code === 'INVALID_PARAMS',
          explicitReplacementAllowsEndpointEdit:
            stored.type === 'SOCKS5' &&
            stored.host === 'changed-proxy.example' &&
            stored.port === 9443 &&
            stored.password === replacementSecret,
          oldEndpointNoLongerAuthenticates:
            !Object.prototype.hasOwnProperty.call(
                oldEndpointAuth,
                'authCredentials',
            ),
          replacementAuthenticatesOnlyAtNewEndpoint:
            newEndpointAuth.authCredentials.password === replacementSecret,
        });

      });

  Mocha.it('defines username clearing and rejects ambiguous password intent',
      async function() {

        const originalSecret = ['username', 'original', 'fixture'].join('-');
        const replacementSecret = ['username', 'replacement', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, originalSecret);
        const clearedUsername = await harness.callRpc('getPacMods');
        const ambiguousReplacement = clone(clearedUsername);
        ambiguousReplacement.ownProxies[0].password = replacementSecret;
        const ambiguousReplacementResponse = await harness.callRpcRaw(
            'setPacMods',
            {pacMods: ambiguousReplacement},
        );
        const contradictoryPlaceholder = clone(clearedUsername);
        contradictoryPlaceholder.ownProxies[0].password =
          harness.context.mv3PacMods.REDACTED_PASSWORD;
        contradictoryPlaceholder.ownProxies[0].hasPassword = false;
        const contradictoryResponse = await harness.callRpcRaw(
            'setPacMods',
            {pacMods: contradictoryPlaceholder},
        );
        clearedUsername.ownProxies[0].username = '';
        const preserveResponse = await harness.callRpc('setPacMods', {
          pacMods: clearedUsername,
        });
        const preservedState = harness.getState();
        const preservedAuth = lookupProxyAuth(
            harness,
            preservedState,
            'blank-username',
            'proxy.example',
            8443,
        );

        const explicitReplacement = await harness.callRpc('getPacMods');
        setExplicitPassword(
            explicitReplacement.ownProxies[0],
            replacementSecret,
        );
        const replacementResponse = await harness.callRpc('setPacMods', {
          pacMods: explicitReplacement,
        });
        const explicitRemoval = await harness.callRpc('getPacMods');
        const replacementMetadata = clone(explicitRemoval.ownProxies[0]);
        setExplicitPassword(explicitRemoval.ownProxies[0], '');
        const removalResponse = await harness.callRpc('setPacMods', {
          pacMods: explicitRemoval,
        });
        const removedState = harness.getState();
        const removalMetadata = await harness.callRpc('getPacMods');

        expectNoCredentialExposure(
            [
              contradictoryResponse,
              ambiguousReplacementResponse,
              preserveResponse,
              replacementResponse,
              removalResponse,
            ],
            [originalSecret, replacementSecret],
        );
        expectChecks({
          contradictoryPlaceholderRejected:
            contradictoryResponse.ok === false &&
            contradictoryResponse.error.code === 'INVALID_PARAMS',
          explicitPasswordWithPreservationMetadataRejected:
            ambiguousReplacementResponse.ok === false &&
            ambiguousReplacementResponse.error.code === 'INVALID_PARAMS',
          blankUsernamePreservesPassword:
            preservedState.pacMods.ownProxies[0].username === '' &&
            preservedState.pacMods.ownProxies[0].password === originalSecret &&
            preservedAuth.authCredentials.username === '' &&
            preservedAuth.authCredentials.password === originalSecret,
          replacementModelDescribedPasswordBeforeExplicitEdit:
            replacementMetadata.hasPassword === true,
          explicitEmptyRemovesPasswordWithoutPreservationMetadata:
            removedState.pacMods.ownProxies[0].password === '' &&
            removalMetadata.ownProxies[0].hasPassword === false,
        });

      });

  Mocha.it('rejects an omitted password without valid preservation metadata',
      async function() {

        const secret = ['omitted', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, secret);
        const incomplete = await harness.callRpc('getPacMods');
        delete incomplete.ownProxies[0].credentialRef;
        delete incomplete.ownProxies[0].hasCredentials;
        delete incomplete.ownProxies[0].hasPassword;

        const response = await harness.callRpcRaw('setPacMods', {
          pacMods: incomplete,
        });
        const normalizationFailure = await harness.callRpcRaw(
            'normalizePacMods',
            {pacMods: incomplete},
        );
        const validationFailure = await harness.callRpcRaw(
            'validatePacMods',
            {pacMods: incomplete},
        );
        const implicitRemoval = await harness.callRpc('getPacMods');
        implicitRemoval.ownProxies[0].hasPassword = false;
        const implicitRemovalResponse = await harness.callRpcRaw(
            'setPacMods',
            {pacMods: implicitRemoval},
        );
        const changedIdentityClaim = await harness.callRpc('getPacMods');
        changedIdentityClaim.ownProxies[0].username = 'new-row-claim';
        changedIdentityClaim.ownProxies[0].hasPassword = false;
        delete changedIdentityClaim.ownProxies[0].credentialRef;
        const changedIdentityClaimResponse = await harness.callRpcRaw(
            'setPacMods',
            {pacMods: changedIdentityClaim},
        );
        const invalidRevision = await harness.callRpc('getPacMods');
        invalidRevision.credentialRevision = 'invalid';
        const invalidRevisionResponse = await harness.callRpcRaw(
            'setPacMods',
            {pacMods: invalidRevision},
        );
        const stored = harness.getState().pacMods.ownProxies[0];

        expectNoCredentialExposure(
            [
              response,
              normalizationFailure,
              validationFailure,
              implicitRemovalResponse,
              changedIdentityClaimResponse,
              invalidRevisionResponse,
            ],
            [secret],
        );
        expectChecks({
          ambiguousOmissionRejected:
            response.ok === false &&
            response.error.code === 'INVALID_PARAMS',
          durablePasswordUnchanged: stored.password === secret,
          normalizationFailureSanitized:
            normalizationFailure.ok === false &&
            normalizationFailure.error.code === 'INVALID_PARAMS',
          validationFailureSanitized:
            validationFailure.ok === false &&
            validationFailure.error.code === 'INVALID_PARAMS',
          booleanAloneCannotRemovePassword:
            implicitRemovalResponse.ok === false &&
            implicitRemovalResponse.error.code === 'INVALID_PARAMS',
          changedIdentityCannotTurnOmissionIntoNewPasswordlessRow:
            changedIdentityClaimResponse.ok === false &&
            changedIdentityClaimResponse.error.code === 'INVALID_PARAMS',
          invalidStateVersionRejected:
            invalidRevisionResponse.ok === false &&
            invalidRevisionResponse.error.code === 'INVALID_PARAMS',
        });

      });

  Mocha.it('rejects false password claims and deleted-row reference reuse',
      async function() {

        const secret = ['deleted', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, secret);
        const deletedRowModel = await harness.callRpc('getPacMods');
        const withoutRow = clone(deletedRowModel);
        withoutRow.ownProxies = [];
        await harness.callRpc('setPacMods', {pacMods: withoutRow});

        const deletedReferenceResponse = await harness.callRpcRaw(
            'setPacMods',
            {pacMods: deletedRowModel},
        );
        const falseClaim = createCredentialPacMods('');
        delete falseClaim.ownProxies[0].password;
        falseClaim.ownProxies[0].hasPassword = true;
        const falseClaimResponse = await harness.callRpcRaw('setPacMods', {
          pacMods: falseClaim,
        });
        const placeholderClaim = createCredentialPacMods(
            harness.context.mv3PacMods.REDACTED_PASSWORD,
            {host: 'new-proxy.example'},
        );
        const placeholderResponse = await harness.callRpcRaw('setPacMods', {
          pacMods: placeholderClaim,
        });

        expectNoCredentialExposure(
            [
              deletedReferenceResponse,
              falseClaimResponse,
              placeholderResponse,
            ],
            [secret],
        );
        expectChecks({
          deletedReferenceRejected:
            deletedReferenceResponse.ok === false &&
            deletedReferenceResponse.error.code === 'INVALID_PARAMS',
          falseHasPasswordRejected:
            falseClaimResponse.ok === false &&
            falseClaimResponse.error.code === 'INVALID_PARAMS',
          placeholderOnNewRowRejected:
            placeholderResponse.ok === false &&
            placeholderResponse.error.code === 'INVALID_PARAMS',
          placeholderNeverPersisted:
            !JSON.stringify(harness.getState().pacMods).includes(
                harness.context.mv3PacMods.REDACTED_PASSWORD,
            ),
          deletedRowRemainsDeleted:
            harness.getState().pacMods.ownProxies.length === 0,
        });

      });

  Mocha.it('rejects stale preservation metadata without breaking later saves',
      async function() {

        const secret = ['stale', 'credential', 'fixture'].join('-');
        const nextSecret = ['fresh', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, secret);
        const staleModel = await harness.callRpc('getPacMods');
        const concurrentUpdate = clone(staleModel);
        concurrentUpdate.ownProxies[0].username = 'concurrently-updated-user';
        const updatePromise = harness.callRpc('setPacMods', {
          pacMods: concurrentUpdate,
        });
        const stalePromise = harness.callRpcRaw('setPacMods', {
          pacMods: staleModel,
        });
        const [updateResponse, staleResponse] = await Promise.all([
          updatePromise,
          stalePromise,
        ]);
        const freshResponse = await harness.callRpc('setPacMods', {
          pacMods: createCredentialPacMods(nextSecret, {
            username: 'fresh-user',
          }),
        });
        const stored = harness.getState().pacMods.ownProxies[0];

        expectNoCredentialExposure(
            [updateResponse, staleResponse],
            [secret, nextSecret],
        );
        expectNoCredentialExposure(freshResponse, [secret, nextSecret]);
        expectChecks({
          staleSaveRejected:
            staleResponse.ok === false &&
            staleResponse.error.code === 'INVALID_PARAMS',
          queueContinuesAfterRejection:
            stored.username === 'fresh-user' &&
            stored.password === nextSecret,
        });

      });

  Mocha.it('rejects stale pages and validates references across worker reloads',
      async function() {

        const originalSecret = ['reload', 'original', 'fixture'].join('-');
        const newerSecret = ['reload', 'newer', 'fixture'].join('-');
        const firstWorker = await createRuntimeHarness();
        await seedCredentialState(firstWorker, originalSecret);
        const openPageModel = await firstWorker.callRpc('getPacMods');

        await firstWorker.callRpc('setPacMods', {
          pacMods: createCredentialPacMods(newerSecret),
        });
        const stalePageSave = clone(openPageModel);
        stalePageSave.noDirect = true;
        const stalePageResponse = await firstWorker.callRpcRaw('setPacMods', {
          pacMods: stalePageSave,
        });
        const afterStalePage = firstWorker.getState().pacMods;
        const currentPageModel = await firstWorker.callRpc('getPacMods');

        const restartedWorker = await createRuntimeHarness({
          pacMods: firstWorker.getState().pacMods,
          pacModsRevision: firstWorker.getState().pacModsRevision,
        });
        currentPageModel.noDirect = true;
        const restartResponse = await restartedWorker.callRpc('setPacMods', {
          pacMods: currentPageModel,
        });
        const afterRestart = restartedWorker.getState().pacMods;
        const restartModel = await restartedWorker.callRpc('getPacMods');
        const incompatibleWorker = await createRuntimeHarness({
          pacMods: createCredentialPacMods(newerSecret, {
            username: 'changed-after-restart',
          }),
          pacModsRevision: firstWorker.getState().pacModsRevision,
        });
        const incompatibleRestartResponse = await incompatibleWorker.callRpcRaw(
            'setPacMods',
            {pacMods: openPageModel},
        );

        expectNoCredentialExposure(
            [
              stalePageResponse,
              restartResponse,
              incompatibleRestartResponse,
            ],
            [originalSecret, newerSecret],
        );
        expectChecks({
          stalePageRejectedWithoutRestoringOlderPassword:
            stalePageResponse.ok === false &&
            stalePageResponse.error.code === 'INVALID_PARAMS' &&
            afterStalePage.noDirect === false &&
            afterStalePage.ownProxies[0].password === newerSecret,
          alreadyOpenCurrentPageSurvivesWorkerReload:
            restartResponse.ok === true &&
            afterRestart.noDirect === true &&
            afterRestart.ownProxies[0].password === newerSecret,
          incompatibleRestartReferenceRejected:
            incompatibleRestartResponse.ok === false &&
            incompatibleRestartResponse.error.code === 'INVALID_PARAMS',
          responseReferenceStillContainsNoSecret:
            !JSON.stringify(
                restartModel.ownProxies[0].credentialRef,
            ).includes(newerSecret),
        });

      });

  Mocha.it('does not recycle credential references across a state reset',
      async function() {

        const originalSecret = ['reset', 'original', 'fixture'].join('-');
        const replacementSecret = ['reset', 'replacement', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        await seedCredentialState(harness, originalSecret);
        const oldModel = await harness.callRpc('getPacMods');

        const resetResponse = await harness.callRpc('resetMv3State');
        const replacementResponse = await harness.callRpc('setPacMods', {
          pacMods: createCredentialPacMods(replacementSecret),
        });
        const staleResponse = await harness.callRpcRaw('setPacMods', {
          pacMods: oldModel,
        });
        const stored = harness.getState().pacMods.ownProxies[0];

        expectNoCredentialExposure(
            [resetResponse, replacementResponse, staleResponse],
            [originalSecret, replacementSecret],
        );
        expectChecks({
          resetReturnsAcknowledgementOnly:
            resetResponse.ok === true &&
            Object.keys(resetResponse).length === 1,
          oldReferenceRejectedAfterResetAndRecreate:
            staleResponse.ok === false &&
            staleResponse.error.code === 'INVALID_PARAMS',
          replacementCredentialRemainsActive:
            stored.password === replacementSecret,
        });

      });

  Mocha.it('sanitizes legacy and migrated credential formats',
      async function() {

        const secret = ['legacy', 'credential', 'fixture'].join('-');
        const harness = await createRuntimeHarness();
        const legacyPacMods = {
          ownProxies: [`HTTPS legacy-user:${secret}@proxy.example:9443`],
        };
        const legacySaveResponse = await harness.callRpc('setPacMods', {
          pacMods: legacyPacMods,
        });

        const stateResponse = await harness.callRpc('getState');
        const migrationResponse = harness.context.mv3State.sanitizeRpcValue({
          ok: true,
          result: {
            proposedMigration: {
              applyValues: {pacMods: legacyPacMods},
            },
          },
        });
        expectNoCredentialExposure(legacySaveResponse, [secret]);
        expectNoCredentialExposure(stateResponse, [secret]);
        expectNoCredentialExposure(migrationResponse, [secret]);
        expectChecks({
          legacyUsernameAvailableForEditing:
            stateResponse.state.pacMods.ownProxies[0].username === 'legacy-user',
          legacyPasswordDescribed:
            stateResponse.state.pacMods.ownProxies[0].hasPassword === true,
          legacyExplicitPasswordPersisted:
            harness.getState().pacMods.ownProxies[0].password === secret,
          migrationUsesSafeProxyModel:
            migrationResponse.result.proposedMigration.applyValues
                .pacMods.ownProxies[0].hasPassword === true,
        });

      });

});
