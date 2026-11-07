import test from 'node:test';import assert from 'node:assert/strict';import{buildServer,memoryStore}from'./server.js';import{randomUUID}from'node:crypto';
import{simulatedAuth}from'./test-support.js';
import type { DataSharingRepository } from './data-sharing-repository.js';
import type { ConsentRepository } from './consent-repository.js';
const setup=async()=>{const store=memoryStore(),app=buildServer({store,adminSecret:'staging-secret',collectorAuthorization:simulatedAuth()}),subjectId=randomUUID();const r=await app.inject({method:'POST',url:'/v1/staging/devices',headers:{'x-admin-secret':'staging-secret'},payload:{subjectId}});return{app,store,token:r.json().token as string}};
const grantExpiry=()=>new Date(Date.now()+60_000).toISOString();
test('health reports metadata-only staging without claiming persistence when repositories are absent',async()=>{const app=buildServer(),r=await app.inject({method:'GET',url:'/health'});assert.equal(r.json().collector,'metadata-only');assert.equal(r.json().durability,'memory');await app.close()});
test('serves web app index.html on root path',async()=>{const app=buildServer(),r=await app.inject({method:'GET',url:'/'});assert.equal(r.statusCode,200);assert.match(r.headers['content-type']??'',/text\/html/);await app.close()});
test('zero trust denies unauthenticated consent writes',async()=>{const app=buildServer(),r=await app.inject({method:'POST',url:'/v1/consent-events',payload:{}});assert.equal(r.statusCode,401);await app.close()});
test('data-sharing route reads and writes the configured durable repository', async () => {
  const store = memoryStore();
  let enabled = false;
  const repository: DataSharingRepository = {
    async get() { return enabled; },
    async set(_subjectId, value) { enabled = value; }
  };
  const app = buildServer({ store, dataSharingRepository: repository, adminSecret: 'staging-secret' });
  const enrolled = await app.inject({ method: 'POST', url: '/v1/staging/devices', headers: { 'x-admin-secret': 'staging-secret' }, payload: { subjectId: randomUUID() } });
  const headers = { authorization: `Bearer ${enrolled.json().token as string}` };
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/collector/eligibility', headers })).json().dataSharing, false);
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/data-sharing', headers, payload: { dataSharing: true } })).statusCode, 200);
    assert.equal(store.dataSharing.size, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/collector/eligibility', headers })).json().dataSharing, true);
  } finally { await app.close(); }
});

test('repository failures fail closed on data-sharing reads and writes', async () => {
  const app = buildServer({
    adminSecret: 'staging-secret',
    dataSharingRepository: {
      async get() { throw new Error('database unavailable'); },
      async set() { throw new Error('database unavailable'); }
    }
  });
  const enrolled = await app.inject({ method: 'POST', url: '/v1/staging/devices', headers: { 'x-admin-secret': 'staging-secret' }, payload: { subjectId: randomUUID() } });
  const headers = { authorization: `Bearer ${enrolled.json().token as string}` };
  try {
    const read = await app.inject({ method: 'GET', url: '/v1/collector/eligibility', headers });
    assert.equal(read.statusCode, 503);
    assert.equal(read.json().error, 'data_sharing_unavailable');
    const write = await app.inject({ method: 'PUT', url: '/v1/data-sharing', headers, payload: { dataSharing: true } });
    assert.equal(write.statusCode, 503);
    assert.equal(write.json().error, 'data_sharing_unavailable');
  } finally { await app.close(); }
});

test('legacy collector eligibility uses persisted consent state and does not revive revoked grants', async () => {
  const repository: ConsentRepository = {
    async recordDecision(input) { return { ...input, id: randomUUID(), eventSequence: 1, occurredAt: new Date().toISOString() }; },
    async getCurrent() { return null; },
    async getHistory() { return []; },
    async getLatestForSubject(subjectId) {
      return { id: randomUUID(), subjectId, purpose: 'Detect unexpected data destinations', policyVersion: '1', purposeVersion: '1', state: 'revoked' };
    }
  };
  const app = buildServer({ adminSecret: 'staging-secret', consentRepository: repository });
  const enrolled = await app.inject({ method: 'POST', url: '/v1/staging/devices', headers: { 'x-admin-secret': 'staging-secret' }, payload: { subjectId: randomUUID() } });
  const headers = { authorization: `Bearer ${enrolled.json().token as string}` };
  try {
    const eligibility = await app.inject({ method: 'GET', url: '/v1/collector/eligibility', headers });
    assert.equal(eligibility.json().consentState, 'not_granted');
    assert.equal(eligibility.json().consentId, null);
  } finally { await app.close(); }
});

test('POST eligibility needs independent data-sharing opt-in and returns a short-lived authorization', async () => {
  const { app, store, token } = await setup();
  const permissionId = randomUUID();
  const headers = { authorization: `Bearer ${token}` };
  try {
    const grant = await app.inject({
      method: 'POST', url: '/v1/consent-events', headers,
      payload: {
        permissionId, requestId: randomUUID(), action: 'grant', expiresAt: grantExpiry(),
        policyVersion: 'privacy-1', purposeVersion: 'network-safety-1',
        purpose: 'Detect unexpected data destinations'
      }
    });
    assert.equal(grant.statusCode, 202);
    const payload = { permissionId, purpose: 'Detect unexpected data destinations', activationRequested: true };
    const beforeOptIn = await app.inject({ method: 'POST', url: '/v1/collector/eligibility', headers, payload });
    assert.equal(beforeOptIn.json().state, 'NOT_ELIGIBLE');
    assert.equal(beforeOptIn.json().reason, 'data_sharing_disabled');
    assert.equal(store.consents.get(permissionId)?.state, 'granted');

    await app.inject({ method: 'PUT', url: '/v1/data-sharing', headers, payload: { dataSharing: true } });
    const eligible = await app.inject({ method: 'POST', url: '/v1/collector/eligibility', headers, payload });
    assert.equal(eligible.json().state, 'ELIGIBLE');
    assert.ok(eligible.json().authorizationId);
    assert.ok(Date.parse(eligible.json().expiresAt) <= Date.now() + 15_000);

    store.consents.get(permissionId)!.expiresAt = new Date(Date.now() - 1_000).toISOString();
    const expired = await app.inject({ method: 'POST', url: '/v1/collector/eligibility', headers, payload });
    assert.equal(expired.json().state, 'NOT_ELIGIBLE');
    assert.equal(expired.json().reason, 'consent_expired');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/metadata-batches', headers, payload: { batchId: randomUUID(), schemaVersion: '2026-08-01', observations: [{ eventId: randomUUID(), occurredAt: new Date().toISOString(), sourceApp: null, attribution: 'unknown', destinationHost: 'example.com', protocol: 'dns', bytesBucket: '0-1KB', classification: 'unknown', consentId: permissionId, consentPurpose: 'Detect unexpected data destinations' }] } })).statusCode, 403);
  } finally { await app.close(); }
});

test('grant consent requires a future expiry no more than 24 hours away', async () => {
  const { app, token } = await setup();
  const headers = { authorization: `Bearer ${token}` };
  const base = { permissionId: randomUUID(), requestId: randomUUID(), action: 'grant', policyVersion: 'privacy-1', purposeVersion: '1', purpose: 'A valid consent purpose' };
  try {
    for (const expiresAt of [undefined, new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString()]) {
      const response = await app.inject({ method: 'POST', url: '/v1/consent-events', headers, payload: { ...base, requestId: randomUUID(), expiresAt } });
      assert.equal(response.statusCode, 400);
    }
    const valid = await app.inject({ method: 'POST', url: '/v1/consent-events', headers, payload: { ...base, expiresAt: grantExpiry() } });
    assert.equal(valid.statusCode, 202);
    assert.ok(valid.json().expiresAt);
  } finally { await app.close(); }
});
test('ingestion requires active purpose consent and blocks replay',async()=>{const{app,store,token}=await setup(),permissionId=randomUUID(),headers={authorization:`Bearer ${token}`};await app.inject({method:'PUT',url:'/v1/data-sharing',headers,payload:{dataSharing:true}});await app.inject({method:'POST',url:'/v1/consent-events',headers,payload:{permissionId,requestId:randomUUID(),action:'grant',expiresAt:grantExpiry(),policyVersion:'privacy-1',purposeVersion:'network-safety-1',purpose:'Detect unexpected data destinations'}});const payload={batchId:randomUUID(),schemaVersion:'2026-08-01',observations:[{eventId:randomUUID(),occurredAt:new Date().toISOString(),sourceApp:'com.example.app',attribution:'verified',destinationHost:'api.example.com',protocol:'tls',bytesBucket:'1-10KB',classification:'expected',consentId:permissionId,consentPurpose:'Detect unexpected data destinations'}]};assert.equal((await app.inject({method:'POST',url:'/v1/metadata-batches',headers,payload})).statusCode,202);assert.equal(store.observations.length,1);assert.equal((await app.inject({method:'POST',url:'/v1/metadata-batches',headers,payload})).statusCode,409);await app.close()});
test('revocation immediately blocks ingestion and preserves decision history',async()=>{const{app,store,token}=await setup(),permissionId=randomUUID(),headers={authorization:`Bearer ${token}`};await app.inject({method:'PUT',url:'/v1/data-sharing',headers,payload:{dataSharing:true}});const decision=(action:'grant'|'revoke')=>app.inject({method:'POST',url:'/v1/consent-events',headers,payload:{permissionId,requestId:randomUUID(),...(action==='grant'?{expiresAt:grantExpiry()}:{}),action,policyVersion:'privacy-1',purposeVersion:'network-safety-1',purpose:'Detect unexpected data destinations'}});assert.equal((await decision('grant')).statusCode,202);assert.equal((await decision('revoke')).statusCode,202);const payload={batchId:randomUUID(),schemaVersion:'2026-08-01',observations:[{eventId:randomUUID(),occurredAt:new Date().toISOString(),sourceApp:'com.example.app',attribution:'verified',destinationHost:'api.example.com',protocol:'tls',bytesBucket:'1-10KB',classification:'expected',consentId:permissionId,consentPurpose:'Detect unexpected data destinations'}]};assert.equal((await app.inject({method:'POST',url:'/v1/metadata-batches',headers,payload})).statusCode,403);const history=await app.inject({method:'GET',url:`/v1/consent-events/${permissionId}`,headers});assert.equal(history.statusCode,200);assert.equal(history.json().events.length,2);assert.deepEqual(history.json().events.map((event:any)=>event.action),['grant','revoke']);assert.equal(store.observations.length,0);await app.close()});
test('payload fields fail the minimization contract',async()=>{const{app,token}=await setup();const r=await app.inject({method:'POST',url:'/v1/metadata-batches',headers:{authorization:`Bearer ${token}`},payload:{batchId:randomUUID(),schemaVersion:'2026-08-01',observations:[{payload:'secret'}]}});assert.equal(r.statusCode,400);await app.close()});

test('declined consent never authorizes ingestion', async () => {
  const { app, store, token } = await setup();
  const permissionId = randomUUID();
  const headers = { authorization: ['Bearer', token].join(' ') };
  const decision = await app.inject({
    method: 'POST',
    url: '/v1/consent-events',
    headers,
    payload: {
      permissionId,
      requestId: randomUUID(),
      action: 'deny',
      policyVersion: 'privacy-1',
      purposeVersion: 'network-safety-1',
      purpose: 'Detect unexpected data destinations'
    }
  });
  assert.equal(decision.statusCode, 202);
  const batch = {
    batchId: randomUUID(),
    schemaVersion: '2026-08-01',
    observations: [{
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      sourceApp: 'com.example.app',
      attribution: 'verified',
      destinationHost: 'api.example.com',
      protocol: 'tls',
      bytesBucket: '1-10KB',
      classification: 'expected',
      consentId: permissionId,
      consentPurpose: 'Detect unexpected data destinations'
    }]
  };
  const upload = await app.inject({ method: 'POST', url: '/v1/metadata-batches', headers, payload: batch });
  assert.equal(upload.statusCode, 403);
  assert.equal(upload.json().error, 'active_purpose_consent_required');
  assert.equal(store.observations.length, 0);
  await app.close();
});

test('intelligence and value engine endpoints satisfy openapi contract', async () => {
  const app = buildServer({ allowSyntheticDevelopmentEvents: true });

  // 1. POST /v1/intelligence/events
  const eventId = 'test-evt-99';
  const postRes = await app.inject({
    method: 'POST',
    url: '/v1/intelligence/events',
    payload: {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      app_id: 'com.retail.shop',
      device_id: 'device-test-01',
      network: {
        domain: 'analytics.adservice.net',
        endpoint: '/track/v1',
        method: 'POST',
        status_code: 200
      },
      metadata: {
        purchase_intent: 'high',
        category: 'running_shoes'
      },
      tags: ['commercial', 'shopping']
    }
  });
  assert.equal(postRes.statusCode, 200);
  const eventView = postRes.json();
  assert.equal(eventView.event_id, eventId);
  assert.equal(eventView.classification.category, 'behavioral_commercial');
  assert.equal(typeof eventView.scores.commercial_intent_score, 'number');
  assert.equal(typeof eventView.scores.metadata_value_estimate, 'number');
  assert.equal(eventView.persona.persona, 'heavy_commercial');
  assert.ok(Array.isArray(eventView.metadata_inspection.metadata_items));

  // 2. GET /v1/intelligence/events/:event_id
  const getEventRes = await app.inject({
    method: 'GET',
    url: `/v1/intelligence/events/${eventId}`
  });
  assert.equal(getEventRes.statusCode, 200);
  assert.equal(getEventRes.json().event_id, eventId);

  // 3. GET /v1/inspector/events/:event_id/metadata
  const getMetaRes = await app.inject({
    method: 'GET',
    url: `/v1/inspector/events/${eventId}/metadata`
  });
  assert.equal(getMetaRes.statusCode, 200);
  assert.equal(getMetaRes.json().event_id, eventId);

  // 4. GET /v1/inspector/apps/:app_id/gates
  const getGatesRes = await app.inject({
    method: 'GET',
    url: '/v1/inspector/apps/com.retail.shop/gates'
  });
  assert.equal(getGatesRes.statusCode, 200);
  assert.equal(getGatesRes.json().app_id, 'com.retail.shop');

  // 5. POST /v1/inspector/apps/:app_id/gates
  const updateGatesRes = await app.inject({
    method: 'POST',
    url: '/v1/inspector/apps/com.retail.shop/gates',
    payload: {
      app_id: 'com.retail.shop',
      gates: [
        {
          metadata_type: 'commercial',
          default_state: 'blocked'
        }
      ]
    }
  });
  assert.equal(updateGatesRes.statusCode, 200);
  assert.equal(updateGatesRes.json().gates[0].default_state, 'blocked');

  // 6. POST /v1/marketplace/match
  const matchRes = await app.inject({
    method: 'POST',
    url: '/v1/marketplace/match',
    payload: {
      app_id: 'com.retail.shop'
    }
  });
  assert.equal(matchRes.statusCode, 200);
  assert.ok(Array.isArray(matchRes.json().matched_offers));

  // 7. GET /v1/intelligence/apps/:app_id/summary
  const summaryRes = await app.inject({
    method: 'GET',
    url: '/v1/intelligence/apps/com.retail.shop/summary'
  });
  assert.equal(summaryRes.statusCode, 200);
  assert.equal(summaryRes.json().app_id, 'com.retail.shop');
  assert.ok(summaryRes.json().average_scores);

  await app.close();
});

test('wallet mechanic endpoints satisfy openapi contract', async () => {
  const app = buildServer({ adminSecret: 'sec' });

  // 1. GET /v1/wallet/:user_id
  const summaryRes = await app.inject({
    method: 'GET',
    url: '/v1/wallet/user_demo_01'
  });
  assert.equal(summaryRes.statusCode, 200);
  const summary = summaryRes.json();
  assert.equal(typeof summary.total_earned, 'number');
  assert.equal(typeof summary.total_pending, 'number');
  assert.equal(typeof summary.total_settled, 'number');
  assert.ok(summary.earnings_by_app);
  assert.ok(summary.earnings_by_metadata);

  // 2. GET /v1/wallet/:user_id/ledger
  const ledgerRes = await app.inject({
    method: 'GET',
    url: '/v1/wallet/user_demo_01/ledger?page=1&page_size=10'
  });
  assert.equal(ledgerRes.statusCode, 200);
  const ledger = ledgerRes.json();
  assert.ok(Array.isArray(ledger.items));
  assert.equal(ledger.page, 1);
  assert.equal(ledger.page_size, 10);
  assert.ok(ledger.items.length > 0);
  assert.ok(ledger.items[0].ledger_id);
  assert.ok(ledger.items[0].wallet_id);

  // 3. GET /v1/wallet/:user_id/progress
  const progressRes = await app.inject({
    method: 'GET',
    url: '/v1/wallet/user_demo_01/progress'
  });
  assert.equal(progressRes.statusCode, 200);
  const progress = progressRes.json();
  assert.equal(typeof progress.level, 'number');
  assert.equal(typeof progress.xp, 'number');
  assert.ok(Array.isArray(progress.milestones_unlocked));
  assert.ok(progress.bonuses);

  // 4. GET /v1/wallet/:user_id/apps
  const appsRes = await app.inject({
    method: 'GET',
    url: '/v1/wallet/user_demo_01/apps'
  });
  assert.equal(appsRes.statusCode, 200);
  assert.ok(appsRes.json().earnings_by_app);

  // 5. GET /v1/wallet/:user_id/metadata
  const metaRes = await app.inject({
    method: 'GET',
    url: '/v1/wallet/user_demo_01/metadata'
  });
  assert.equal(metaRes.statusCode, 200);
  assert.ok(metaRes.json().earnings_by_metadata);

  // 6. POST /v1/wallet/events/earn
  const earnRes = await app.inject({
    method: 'POST',
    url: '/v1/wallet/events/earn',
    payload: {
      event_id: 'evt-test-earn-01',
      user_id: 'user_demo_01'
    }
  });
  assert.equal(earnRes.statusCode, 200);
  const earn = earnRes.json();
  assert.ok(earn.ledger_entry);
  assert.ok(earn.wallet);
  assert.ok(earn.progression_update);
  assert.equal(earn.ledger_entry.event_id, 'evt-test-earn-01');

  // 7. POST /v1/wallet/:user_id/payout
  const payoutRes = await app.inject({
    method: 'POST',
    url: '/v1/wallet/user_demo_01/payout',
    payload: {
      amount: 5.00,
      method: 'partner_credit'
    }
  });
  assert.equal(payoutRes.statusCode, 200);
  const payout = payoutRes.json();
  assert.ok(payout.payout);
  assert.ok(payout.wallet);
  assert.equal(payout.payout.amount, 5.00);
  assert.equal(payout.payout.method, 'partner_credit');
  assert.equal(payout.payout.status, 'completed');

  await app.close();
});

test('permissions control endpoints satisfy openapi contract', async () => {
  const app = buildServer({ adminSecret: 'sec' });

  // 1. GET /v1/permissions/users/:user_id/apps
  const appsRes = await app.inject({
    method: 'GET',
    url: '/v1/permissions/users/user_demo_01/apps'
  });
  assert.equal(appsRes.statusCode, 200);
  const appsData = appsRes.json();
  assert.ok(Array.isArray(appsData.apps));
  assert.ok(appsData.apps.length > 0);
  assert.equal(appsData.apps[0].app_id, 'com.example.shop');

  // 2. POST /v1/permissions/users/:user_id/apps
  const updateAppsRes = await app.inject({
    method: 'POST',
    url: '/v1/permissions/users/user_demo_01/apps',
    payload: {
      apps: [
        {
          app_id: 'com.example.shop',
          app_name: 'Shop Sample',
          state: 'limited',
          reason: 'Restricted by user test',
          last_updated: new Date().toISOString()
        }
      ]
    }
  });
  assert.equal(updateAppsRes.statusCode, 200);
  assert.equal(updateAppsRes.json().apps.find((a: any) => a.app_id === 'com.example.shop').state, 'limited');

  // 3. GET /v1/permissions/users/:user_id/apps/:app_id/metadata
  const metaRes = await app.inject({
    method: 'GET',
    url: '/v1/permissions/users/user_demo_01/apps/com.example.shop/metadata'
  });
  assert.equal(metaRes.statusCode, 200);
  const metaData = metaRes.json();
  assert.ok(Array.isArray(metaData.metadata_permissions));
  assert.ok(metaData.metadata_permissions.length > 0);

  // 4. POST /v1/permissions/users/:user_id/apps/:app_id/metadata
  const updateMetaRes = await app.inject({
    method: 'POST',
    url: '/v1/permissions/users/user_demo_01/apps/com.example.shop/metadata',
    payload: {
      metadata_permissions: [
        {
          metadata_type: 'commercial',
          key: 'category_totals',
          state: 'blocked',
          last_updated: new Date().toISOString()
        }
      ]
    }
  });
  assert.equal(updateMetaRes.statusCode, 200);
  assert.equal(updateMetaRes.json().metadata_permissions.find((m: any) => m.metadata_type === 'commercial').state, 'blocked');

  // 5. GET /v1/permissions/users/:user_id/buyers
  const buyersRes = await app.inject({
    method: 'GET',
    url: '/v1/permissions/users/user_demo_01/buyers'
  });
  assert.equal(buyersRes.statusCode, 200);
  const buyersData = buyersRes.json();
  assert.ok(Array.isArray(buyersData.buyers));

  // 6. POST /v1/permissions/users/:user_id/buyers
  const updateBuyersRes = await app.inject({
    method: 'POST',
    url: '/v1/permissions/users/user_demo_01/buyers',
    payload: {
      buyers: [
        {
          buyer_category: 'AdTech & Behavioral Retargeting',
          state: 'blocked',
          max_value_band: 0,
          last_updated: new Date().toISOString()
        }
      ]
    }
  });
  assert.equal(updateBuyersRes.statusCode, 200);

  // 7. GET /v1/permissions/users/:user_id/effective
  const effectiveRes = await app.inject({
    method: 'GET',
    url: '/v1/permissions/users/user_demo_01/effective'
  });
  assert.equal(effectiveRes.statusCode, 200);
  const effective = effectiveRes.json();
  assert.equal(effective.user_id, 'user_demo_01');
  assert.ok(Array.isArray(effective.apps));
  assert.ok(Array.isArray(effective.metadata_permissions));
  assert.ok(Array.isArray(effective.buyers));

  // 8. GET /v1/permissions/users/:user_id/consent-log
  const logRes = await app.inject({
    method: 'GET',
    url: '/v1/permissions/users/user_demo_01/consent-log?page=1&page_size=10'
  });
  assert.equal(logRes.statusCode, 200);
  const logData = logRes.json();
  assert.ok(Array.isArray(logData.items));
  assert.equal(logData.page, 1);
  assert.ok(logData.items.length > 0);
  assert.ok(logData.items[0].log_id);

  await app.close();
});

test('wallet permissions enforcement: blocked apps, metadata, buyers deny earnings and payouts', async () => {
  const app = buildServer({ adminSecret: 'sec' });

  // 1. Initial earn succeeds
  const earnRes1 = await app.inject({
    method: 'POST',
    url: '/v1/wallet/events/earn',
    payload: {
      event_id: 'evt-perm-test-01',
      user_id: 'user_demo_01'
    }
  });
  assert.equal(earnRes1.statusCode, 200);
  assert.equal(earnRes1.json().permitted, true);
  assert.equal(earnRes1.json().ledger_entry.permission_state, 'permitted');

  // 2. Block the app 'com.example.shop'
  const blockAppRes = await app.inject({
    method: 'POST',
    url: '/v1/permissions/users/user_demo_01/apps',
    payload: {
      apps: [
        {
          app_id: 'com.example.shop',
          app_name: 'Shop Sample',
          state: 'blocked',
          reason: 'Blocked by test enforcement',
          last_updated: new Date().toISOString()
        }
      ]
    }
  });
  assert.equal(blockAppRes.statusCode, 200);

  // 3. Earning from blocked app is denied
  const earnBlockedAppRes = await app.inject({
    method: 'POST',
    url: '/v1/wallet/events/earn',
    payload: {
      event_id: 'evt-perm-test-02',
      user_id: 'user_demo_01'
    }
  });
  assert.equal(earnBlockedAppRes.statusCode, 200);
  assert.equal(earnBlockedAppRes.json().permitted, false);
  assert.equal(earnBlockedAppRes.json().ledger_entry.permission_state, 'denied');
  assert.equal(earnBlockedAppRes.json().ledger_entry.status, 'rejected');
  assert.ok(earnBlockedAppRes.json().denial_reason.includes('blocked by user permission policy'));

  // 4. Ledger reflects denied entry and reason
  const ledgerRes = await app.inject({
    method: 'GET',
    url: '/v1/wallet/user_demo_01/ledger?page=1&page_size=5'
  });
  assert.equal(ledgerRes.statusCode, 200);
  const ledgerItems = ledgerRes.json().items;
  assert.ok(ledgerItems.some((i: any) => i.permission_state === 'denied'));

  // 5. Payout request is denied when earning source app is blocked
  const payoutDeniedRes = await app.inject({
    method: 'POST',
    url: '/v1/wallet/user_demo_01/payout',
    payload: {
      amount: 5.00,
      method: 'bank_transfer'
    }
  });
  assert.equal(payoutDeniedRes.statusCode, 200);
  assert.equal(payoutDeniedRes.json().permitted, false);
  assert.ok(payoutDeniedRes.json().denial_reason);

  await app.close();
});

test('branding endpoints return official brand and mascot specification', async () => {
  const app = buildServer({ adminSecret: 'sec' });

  const res = await app.inject({
    method: 'GET',
    url: '/v1/branding/mascot'
  });
  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.equal(data.schemaVersion, '1.0');
  assert.equal(data.productName, 'KICK’S');
  assert.equal(data.ownershipLabel, 'A product of DataStorm Inc.');
  assert.equal(data.assetVersion, 'mascot-2026-09-15-01');
  assert.equal(data.minimumAppVersion, '0.2.5');
  assert.equal(data.altText, 'KICK’S orange and gold mascot with blue eyes and glowing data rings');
  assert.ok(data.assets?.primary?.url.includes('mascot-2026-09-15-01.webp'));
  assert.equal(data.assets?.primary?.mimeType, 'image/webp');
  assert.equal(data.assets?.primary?.width, 1024);
  assert.equal(data.assets?.primary?.height, 1024);

  const resGeneral = await app.inject({
    method: 'GET',
    url: '/v1/branding'
  });
  assert.equal(resGeneral.statusCode, 200);
  assert.deepEqual(resGeneral.json(), data);

  await app.close();
});




// --- Device-bearer enrollment + GET eligibility (new repo, PR #1) ---
// These replace the OIDC-era enroll/eligibility contract: no IdP token is
// accepted anywhere; enrollment mints the device bearer token itself.

test('device-bearer enrollment mints a token bound to the subject', async () => {
  const app = buildServer({ adminSecret: 'staging-secret' });
  const subjectId = randomUUID(), deviceId = randomUUID();
  const enrolled = await app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { deviceId, subjectId } });
  assert.equal(enrolled.statusCode, 201);
  assert.equal(enrolled.json().deviceId, deviceId);
  assert.equal(enrolled.json().tokenType, 'Bearer');
  assert.equal(typeof enrolled.json().token, 'string');
  // The minted token authenticates consent + ingestion like any device token.
  const headers = { authorization: `Bearer ${enrolled.json().token as string}` };
  const permissionId = randomUUID();
  assert.equal((await app.inject({ method: 'POST', url: '/v1/consent-events', headers, payload: { permissionId, requestId: randomUUID(), action: 'grant', expiresAt: grantExpiry(), policyVersion: 'privacy-1', purposeVersion: 'network-safety-1', purpose: 'Detect unexpected data destinations' } })).statusCode, 202);
  await app.close();
});

test('enrollment rejects a device owned by another account', async () => {
  const app = buildServer({ adminSecret: 'staging-secret' });
  const deviceId = randomUUID();
  assert.equal((await app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { deviceId, subjectId: randomUUID() } })).statusCode, 201);
  const second = await app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { deviceId, subjectId: randomUUID() } });
  assert.equal(second.statusCode, 403);
  assert.equal(second.json().error, 'device_owned_by_another_account');
  await app.close();
});

test('production enrollment cannot be enabled by the bootstrap environment flag', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousEnrollmentFlag = process.env.KICKS_ENABLE_DEVICE_ENROLLMENT;
  process.env.NODE_ENV = 'production';
  process.env.KICKS_ENABLE_DEVICE_ENROLLMENT = 'true';
  const app = buildServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/devices/enroll',
      payload: { deviceId: randomUUID(), subjectId: randomUUID() }
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'device_enrollment_disabled');
  } finally {
    await app.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousEnrollmentFlag === undefined) delete process.env.KICKS_ENABLE_DEVICE_ENROLLMENT;
    else process.env.KICKS_ENABLE_DEVICE_ENROLLMENT = previousEnrollmentFlag;
  }
});

test('GET eligibility returns the collector gate view for the native client', async () => {
  const { app, store, token } = await setup();
  const headers = { authorization: `Bearer ${token}` };
  const before = await app.inject({ method: 'GET', url: '/v1/collector/eligibility', headers });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().sessionActive, true);
  assert.equal(before.json().consentState, 'not_granted');
  assert.equal(before.json().consentId, null);
  assert.equal(before.json().dataSharing, false);
  const permissionId = randomUUID();
  await app.inject({ method: 'POST', url: '/v1/consent-events', headers, payload: { permissionId, requestId: randomUUID(), action: 'grant', expiresAt: grantExpiry(), policyVersion: 'privacy-1', purposeVersion: 'network-safety-1', purpose: 'Detect unexpected data destinations' } });
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/data-sharing', headers, payload: { dataSharing: true } })).statusCode, 200);
  const after = await app.inject({ method: 'GET', url: '/v1/collector/eligibility', headers });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json().consentState, 'granted');
  assert.equal(after.json().consentId, permissionId);
  assert.equal(after.json().consentPurpose, 'Detect unexpected data destinations');
  assert.equal(after.json().dataSharing, true);
  assert.equal(after.json().deviceOwnerAccountId, after.json().accountId);
  assert.equal(store.observations.length, 0);
  await app.close();
});

test('GET eligibility and data-sharing reject unauthenticated callers', async () => {
  const app = buildServer();
  assert.equal((await app.inject({ method: 'GET', url: '/v1/collector/eligibility' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/data-sharing', payload: { dataSharing: true } })).statusCode, 401);
  await app.close();
});
