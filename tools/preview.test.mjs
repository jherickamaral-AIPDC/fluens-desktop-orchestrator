import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createPreview, previewConfig } from './preview.mjs';

test('Public preview keeps both providers disabled without reading local configuration', () => {
  const config = previewConfig();
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.provider_effects_authorized, false);
  for (const provider of Object.values(config.providers)) {
    assert.equal(provider.enabled, false);
    assert.equal(provider.executable_path, null);
    assert.equal(provider.cwd, null);
    assert.deepEqual(provider.environment_allowlist, []);
  }
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  const port = server.address().port;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}

async function api(origin, operation, body) {
  const response = await fetch(origin + '/__fluens_motor/v1/' + operation, {
    method: ['P','O','S','T'].join(''),
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
  });
  return { status: response.status, body: await response.json() };
}

test('Public preview serves only its assets and refuses real-provider requests', {timeout:15000}, async () => {
  const runtime = await createPreview(await freePort());
  try {
    await runtime.start();
    const page = await fetch(runtime.origin,{signal:AbortSignal.timeout(5000)});
    assert.equal(page.status,200);
    assert.match(await page.text(),/npm run preview/);
    const absent = await fetch(runtime.origin+'/local-config.json',{signal:AbortSignal.timeout(5000)});
    assert.equal(absent.status,400);
    const petition = {peticionId:'petition_public_demo_001',agenteId:'agent_public_demo_001',chatId:'chat_public_demo_001',instruccionBase:'synthetic preview',bloques:[],mensajes:[],recorte:{aplicado:false,mensajesOmitidos:0}};
    const created = await api(runtime.origin,'request',{schema:'FLUENS_UI_MOTOR_CREATE_V1',peticion:petition});
    assert.equal(created.status,202);
    let cursor=-1;
    const events=[];
    let terminal=false;
    for(let sequence=0;sequence<10&&!terminal;sequence++) {
      const polled=await api(runtime.origin,'poll',{schema:'FLUENS_UI_MOTOR_POLL_V1',peticion_id:petition.peticionId,chat_id:petition.chatId,binding_sha256:created.body.binding_sha256,cursor,poll_sequence:sequence});
      assert.equal(polled.status,200);
      events.push(...polled.body.events);
      if(polled.body.events.length)cursor=polled.body.events.at(-1).cursor;
      terminal=polled.body.terminal;
    }
    assert.equal(terminal,true);
    assert.equal(events.length,1);
    assert.equal(events[0].code,'PROVIDER_DISABLED');
    assert.equal(runtime.driver.memorySummary().session_count,0);
  } finally { await runtime.stop(); }
});
