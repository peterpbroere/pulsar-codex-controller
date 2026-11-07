const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { VoiceAudio } = require('../dist/main/voice-audio');

const source = fs.readFileSync(require.resolve('../ui/voice.js'), 'utf8');
function harness() {
  const commands = [], replies = [], states = [], errors = [], ended = [];
  let handler, gumCalls = 0, enumCalls = 0, audioElements = 0, pc;
  const elements = [], deferredPlays = [];
  let resolveMedia;
  class FakeTrack { constructor() { this.stopped = 0; } stop() { this.stopped++; } }
  class FakePeer {
    constructor() { this.connectionState = 'new'; this.iceGatheringState = 'complete'; this.receivers = []; this.senders = []; this.transceivers = []; pc = this; }
    addTransceiver(track, opts) { this.transceivers.push({ track, opts }); this.senders.push({ track }); }
    createDataChannel(name, options) { this.dataChannel = { name, options }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=test\r\ns=test\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-ufrag:abc\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    getReceivers() { return this.receivers; }
    getSenders() { return this.senders; }
    receive(track, streams) { this.receivers.push({ track }); this.ontrack({ track, streams }); }
    close() { this.closed = true; this.connectionState = 'closed'; }
    addEventListener() {} removeEventListener() {}
  }
  class FakeStream { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } }
  class FakeAudio {
    constructor() { this.pauseCalls = 0; this.playCalls = 0; this.srcObject = null; this.removed = false; }
    play() { this.playCalls++; const deferred = deferredPlays.shift(); return deferred ? deferred.promise : Promise.resolve(); }
    pause() { this.pauseCalls++; }
    remove() { this.removed = true; }
  }
  const track = new FakeTrack();
  const context = {
    window: { voiceHost: {
      listen(fn) { handler = fn; }, reply(...args) { replies.push(args); },
      state(...args) { states.push(args); }, error(...args) { errors.push(args); }, ended(...args) { ended.push(args); },
    } },
    navigator: { mediaDevices: {
      getUserMedia() { gumCalls++; return new Promise(resolve => { resolveMedia = resolve; }); },
      async enumerateDevices() { enumCalls++; return [{ kind: 'audioinput', deviceId: 'mic-1', label: 'Test mic' }]; },
    } },
    RTCPeerConnection: FakePeer, MediaStream: FakeStream, setTimeout, clearTimeout, Promise, Map, Error,
  };
  context.document = { body: { appendChild() {} }, createElement(name) { audioElements++; const element = new FakeAudio(); element.tagName = name; elements.push(element); return element; } };
  vm.runInNewContext(source, context, { filename: 'voice.js' });
  const command = (name, payload) => handler(name, payload);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { command, replies, states, errors, ended, elements, deferNextPlay() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); deferredPlays.push({ promise, resolve, reject }); return { resolve, reject }; }, get gumCalls() { return gumCalls; }, get enumCalls() { return enumCalls; }, get audioElements() { return audioElements; }, get pc() { return pc; }, track, get resolveMedia() { return resolveMedia; }, flush };
}

test('stop while hidden window is loading cancels before microphone capture can begin', async () => {
  const ipc = new EventEmitter();
  let finishLoad, sent = [], permissionRequest, permissionCheck;
  const wc = new EventEmitter(); wc.id = 42; wc.getURL = () => 'file:///trusted/ui/voice.html'; wc.send = (channel, payload) => sent.push([channel, payload]);
  const win = new EventEmitter(); win.webContents = wc; win.isDestroyed = () => false; win.loadFile = () => new Promise(resolve => { finishLoad = resolve; }); win.destroy = () => {};
  const host = new VoiceAudio('C:/trusted', { state() {}, error() {} }, {
    ipc, preload: 'fake-preload', createWindow: options => { assert.equal(options.show, false); assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.nodeIntegration, false); return win; },
    getSession: () => ({ setPermissionRequestHandler: fn => { permissionRequest = fn; }, setPermissionCheckHandler: fn => { permissionCheck = fn; } }),
  });
  const starting = host.start('v-start');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishLoad, 'function');
  assert.equal(host.stop('v-start') instanceof Promise, true);
  await host.stop('v-start');
  finishLoad();
  await assert.rejects(starting, /cancelled/i);
  assert.equal(sent.some(([name]) => name.endsWith(':start')), false);
  const audio = { id: 42, getURL: wc.getURL }, videoDetails = { mediaTypes: ['audio', 'video'] };
  let decision;
  permissionRequest(audio, 'media', allow => { decision = allow; }, videoDetails); assert.equal(decision, false);
  assert.equal(permissionCheck(audio, 'media', wc.getURL(), { mediaType: 'video' }), false);
  await host.close();
});

test('preload send replies are received by the host and resolve renderer commands', async () => {
  const ipc = new EventEmitter();
  const win = new EventEmitter(); win.isDestroyed = () => false; win.loadFile = async () => {}; win.destroy = () => {};
  const wc = new EventEmitter(); wc.id = 43; wc.getURL = () => 'file:///C:/trusted/ui/voice.html';
  wc.send = (channel, payload) => {
    if (channel === 'pulsar-voice-audio:devices') {
      // This matches preload's ipcRenderer.send(channel, token, payload) transport.
      ipc.emit('pulsar-voice-audio:reply', { sender: wc }, payload.token, { value: [{ deviceId: 'mic-2', label: 'Fake mic' }] });
    }
  };
  win.webContents = wc;
  const host = new VoiceAudio('C:/trusted', { state() {}, error() {} }, {
    ipc, preload: 'fake-preload', createWindow: () => win,
    getSession: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
  });
  assert.deepEqual(await host.devices(), [{ id: 'mic-2', label: 'Fake mic' }]);
  assert.equal(ipc.listenerCount('pulsar-voice-audio:reply'), 1);
  await host.close();
  assert.equal(ipc.listenerCount('pulsar-voice-audio:reply'), 0);
});

test('setting playback while inactive stores the value without creating a window', async () => {
  const ipc = new EventEmitter(); let creates = 0;
  const host = new VoiceAudio('C:/trusted', { state() {}, error() {} }, {
    ipc, preload: 'fake-preload', createWindow: () => { creates++; throw Error('should stay lazy'); },
    getSession: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
  });
  await host.setPlayback(true);
  await host.setPlayback(false);
  assert.equal(creates, 0);
  await host.close();
});
test('named input discovery is permitted before recording only for the trusted audio frame',async()=>{
 const ipc=new EventEmitter();let check,request,changes=0,startCalls=0;
 const win=new EventEmitter();win.destroyed=false;win.isDestroyed=()=>win.destroyed;win.destroy=()=>{win.destroyed=true;};win.loadFile=async()=>{};
 const wc=new EventEmitter();wc.id=63;wc.getURL=()=> 'file:///C:/trusted/ui/voice.html';win.webContents=wc;
 wc.send=(channel,payload)=>{if(channel.endsWith(':start'))startCalls++;if(channel.endsWith(':devices'))ipc.emit('pulsar-voice-audio:reply',{sender:wc},payload.token,{value:[{deviceId:'stable-mic',label:'Named microphone'}]});};
 const host=new VoiceAudio('C:/trusted',{state(){},error(){},devicesChanged(){changes++;}},{ipc,preload:'fake',createWindow:()=>win,getSession:()=>({setPermissionRequestHandler(fn){request=fn;},setPermissionCheckHandler(fn){check=fn;}})});
 assert.deepEqual(await host.devices(),[{id:'stable-mic',label:'Named microphone'}]);assert.equal(startCalls,0);
 assert.equal(check(wc,'media','file://',{mediaType:'audio'}),true);
 assert.equal(check(wc,'media','file://',{mediaType:'video'}),false);
 assert.equal(check(wc,'media','file://',{mediaType:'audio',isMainFrame:false}),false);
 assert.equal(check({...wc,id:99},'media','file://',{mediaType:'audio'}),false);
 let allowed;request(wc,'media',value=>{allowed=value;},{mediaTypes:['audio']});assert.equal(allowed,false);
 ipc.emit('pulsar-voice-audio:devices-changed',{sender:wc});assert.equal(changes,1);
 ipc.emit('pulsar-voice-audio:devices-changed',{sender:{id:99,getURL:wc.getURL}});assert.equal(changes,1);
 await host.close();assert.equal(check(wc,'media','file://',{mediaType:'audio'}),false);
});

test('stop destroys an unresponsive capture window, rejects start, and recreates a clean renderer', async () => {
  const ipc = new EventEmitter();
  let created = 0;
  const offer = 'v=0\r\no=test\r\ns=test\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-ufrag:abc\r\n';
  const windows = [];
  const host = new VoiceAudio('C:/trusted', { state() {}, error() {} }, {
    ipc, preload: 'fake-preload',
    createWindow: () => {
      const index = ++created, win = new EventEmitter();
      win.destroyed = false; win.isDestroyed = () => win.destroyed; win.destroy = () => { win.destroyed = true; };
      win.loadFile = async () => {};
      const wc = new EventEmitter(); wc.id = 50 + index; wc.getURL = () => 'file:///C:/trusted/ui/voice.html';
      wc.send = (channel, payload) => {
        if (index === 2 && channel === 'pulsar-voice-audio:start') ipc.emit('pulsar-voice-audio:reply', { sender: wc }, payload.token, { value: offer });
        if (index === 2 && channel === 'pulsar-voice-audio:playback') ipc.emit('pulsar-voice-audio:reply', { sender: wc }, payload.token, { value: undefined });
      };
      win.webContents = wc; windows.push(win); return win;
    },
    getSession: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
  });
  const firstStart = host.start('first');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].destroyed, false);
  await host.stop('first');
  assert.equal(windows[0].destroyed, true);
  await assert.rejects(firstStart, /stopped|cancelled/i);
  assert.equal(await host.start('second'), offer);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].destroyed, false);
  await host.setPlayback(true);
  await host.stop('second');
  assert.equal(windows[1].destroyed, true);
  await host.close();
});

test('renderer does not request the microphone until explicit start; enumeration is passive', async () => {
  const h = harness();
  assert.equal(h.gumCalls, 0);
  h.command('devices', { token: 'd' }); await h.flush();
  assert.equal(h.enumCalls, 1); assert.equal(h.gumCalls, 0);
  assert.equal(JSON.stringify(h.replies[0][1]), JSON.stringify([{ deviceId: 'mic-1', label: 'Test mic' }]));
});

test('stop during permission prompt releases late media tracks and rejects stale start', async () => {
  const h = harness();
  h.command('start', { token: 's', voiceId: 'voice-1' });
  await h.flush(); assert.equal(h.gumCalls, 1);
  h.command('stop', { token: 'x', voiceId: 'voice-1' }); await h.flush();
  h.resolveMedia({ getTracks: () => [h.track], getAudioTracks: () => [h.track] });
  await h.flush();
  assert.equal(h.track.stopped, 1);
  assert.equal(h.replies.some(x => x[0] === 's' && x[2]), true);
  assert.equal(h.states.some(x => x[1] === 'active'), false);
});

test('offer uses negotiated transport and received audio stays silent by default', async () => {
  const h = harness();
  h.command('start', { token: 's', voiceId: 'voice-2', deviceId: 'mic-1' });
  await h.flush(); h.resolveMedia({ getTracks: () => [h.track], getAudioTracks: () => [h.track] });
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.errors, []);
  const offer = h.replies.find(x => x[0] === 's')[1];
  assert.match(offer, /^v=0\r\n/);
  assert.equal(JSON.stringify(h.pc.dataChannel), JSON.stringify({ name: '', options: { negotiated: true, id: 0 } }));
  assert.equal(h.pc.transceivers.length, 1);
  assert.equal(h.pc.transceivers[0].opts.direction, 'sendrecv');
  assert.equal(h.pc.transceivers[0].track, h.track);
  const remote = new h.track.constructor();
  const remoteStream = { getTracks: () => [remote] };
  h.pc.receive(remote, [remoteStream]);
  assert.equal(h.audioElements, 0);
  assert.equal(h.errors.length, 0);
  h.command('stop', { token: 'stop', voiceId: 'voice-2' }); await h.flush();
  assert.equal(h.track.stopped, 1);
  assert.equal(h.pc.closed, true);
  assert.equal(h.track.stopped, 1);
  assert.equal(remote.stopped, 1);
});

test('live playback toggle plays cached audio, mutes immediately, and cleans element on stop', async () => {
  const h = harness();
  h.command('start', { token: 's', voiceId: 'spoken', playback: false });
  await h.flush(); h.resolveMedia({ getTracks: () => [h.track], getAudioTracks: () => [h.track] });
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
  const remote = new h.track.constructor(), stream = { getTracks: () => [remote] };
  h.pc.receive(remote, [stream]);
  assert.equal(h.audioElements, 0);
  h.command('playback', { token: 'on', voiceId: 'spoken', enabled: true }); await h.flush();
  assert.equal(h.audioElements, 1);
  const first = h.elements[0];
  assert.equal(first.playCalls, 1); assert.equal(first.srcObject, stream);
  h.command('playback', { token: 'off', voiceId: 'spoken', enabled: false }); await h.flush();
  assert.equal(first.pauseCalls, 1); assert.equal(first.srcObject, null); assert.equal(first.removed, true);
  assert.equal(h.elements.length, 1);
  h.command('playback', { token: 'on-again', voiceId: 'spoken', enabled: true }); await h.flush();
  assert.equal(h.audioElements, 2);
  const second = h.elements[1]; assert.equal(second.playCalls, 1); assert.equal(second.srcObject, stream);
  h.command('stop', { token: 'stop', voiceId: 'spoken' }); await h.flush();
  assert.equal(second.pauseCalls, 1); assert.equal(second.srcObject, null); assert.equal(second.removed, true);
  assert.equal(remote.stopped, 1); assert.equal(h.track.stopped, 1);
});

test('late play rejection from a muted element cannot fail newer enabled playback', async () => {
  const h = harness();
  h.command('start', { token: 's', voiceId: 'race' });
  await h.flush(); h.resolveMedia({ getTracks: () => [h.track], getAudioTracks: () => [h.track] });
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
  h.pc.receive(new h.track.constructor(), [{ getTracks: () => [] }]);
  const late = h.deferNextPlay();
  h.command('playback', { token: 'one', voiceId: 'race', enabled: true });
  h.command('playback', { token: 'off', voiceId: 'race', enabled: false }); await h.flush();
  h.command('playback', { token: 'two', voiceId: 'race', enabled: true }); await h.flush();
  late.reject(Error('late browser rejection')); await h.flush();
  assert.equal(h.elements.length, 2);
  assert.equal(h.elements[1].playCalls, 1);
  assert.deepEqual(h.errors, []);
});
