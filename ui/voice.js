'use strict';
(() => {
  const sessions = new Map();
  const ptt = new Map();
  let speaking = null;
  const reply = (cmd, value, error) => window.voiceHost.reply(cmd.token, value, error);
  const release = session => {
    if (!session) return;
    session.cancelled = true;
    if (session.timer) clearTimeout(session.timer);
    if (session.audio) {
      session.audio.pause();
      session.audio.srcObject = null;
      session.audio.remove();
      session.audio = null;
    }
    session.remoteStream = null;
    if (session.pc) {
      session.pc.onconnectionstatechange = null;
      const tracks = new Set();
      session.pc.getReceivers().forEach(receiver => { if (receiver.track) tracks.add(receiver.track); });
      session.pc.getSenders().forEach(sender => { if (sender.track) tracks.add(sender.track); });
      session.stream?.getTracks().forEach(track => tracks.add(track));
      tracks.forEach(track => track.stop());
      session.pc.close();
      session.pc = null;
    } else session.stream?.getTracks().forEach(track => track.stop());
    session.stream = null;
  };
  const gather = pc => new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); resolve(); };
    const changed = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(finish, 2000);
    pc.addEventListener('icegatheringstatechange', changed);
  });
  async function playRemote(session) {
    if (!session.playback || !session.remoteStream || session.cancelled) return;
    let audio = session.audio;
    if (!audio) {
      audio = session.audio = document.createElement('audio');
      audio.hidden = true;
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
      audio.srcObject = session.remoteStream;
    }
    try {
      await audio.play();
      if (!session.playback || session.audio !== audio || session.cancelled) {
        audio.pause(); audio.srcObject = null; audio.remove();
      }
    }
    catch {
      if (!session.playback || session.audio !== audio || session.cancelled) return;
      const message = 'Spoken replies are enabled, but audio playback was blocked. Allow audio playback and try again.';
      window.voiceHost.error(session.voiceId, message);
      throw Error(message);
    }
  }
  function setPlayback(session, enabled) {
    session.playback = enabled;
    if (!enabled) {
      if (session.audio) {
        session.audio.pause();
        session.audio.srcObject = null;
        session.audio.remove();
        session.audio = null;
      }
      return Promise.resolve();
    }
    return playRemote(session);
  }
  async function start(cmd) {
    const old = sessions.get(cmd.voiceId);
    if (old) release(old);
    const s = { voiceId: cmd.voiceId, playback: cmd.playback === true, remoteStream: null, audio: null, cancelled: false, stream: null, pc: null, timer: null };
    sessions.set(cmd.voiceId, s);
    window.voiceHost.state(cmd.voiceId, 'connecting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('Microphone capture is unavailable.');
      const audio = cmd.deviceId ? { deviceId: { exact: cmd.deviceId } } : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      if (s.cancelled || sessions.get(cmd.voiceId) !== s) { stream.getTracks().forEach(track => track.stop()); throw Error('Microphone start was cancelled.'); }
      s.stream = stream;
      stream.getAudioTracks().forEach(track => { track.onended = () => {
        if (!s.cancelled && sessions.get(cmd.voiceId) === s) {
          release(s); sessions.delete(cmd.voiceId); window.voiceHost.error(cmd.voiceId, 'Microphone capture ended.');
        }
      }; });
      const pc = s.pc = new RTCPeerConnection({ iceServers: [] });
      stream.getAudioTracks().forEach(track => pc.addTransceiver(track, { direction: 'sendrecv' }));
      pc.createDataChannel('', { negotiated: true, id: 0 });
      pc.ontrack = event => {
        if (s.cancelled || sessions.get(cmd.voiceId) !== s) return;
        s.remoteStream = event.streams?.[0] || new MediaStream([event.track]);
        if (s.playback) void playRemote(s).catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (s.cancelled || sessions.get(cmd.voiceId) !== s) return;
        if (pc.connectionState === 'connected') window.voiceHost.state(cmd.voiceId, 'active');
        else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          if (s.timer) clearTimeout(s.timer);
          s.timer = setTimeout(() => {
            if (!s.cancelled && sessions.get(cmd.voiceId) === s && pc.connectionState !== 'connected') {
              release(s); sessions.delete(cmd.voiceId); window.voiceHost.error(cmd.voiceId, 'Microphone connection was lost.');
            }
          }, pc.connectionState === 'failed' ? 0 : 5000);
        } else if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await gather(pc);
      if (s.cancelled || sessions.get(cmd.voiceId) !== s) throw Error('Microphone start was cancelled.');
      const sdp = pc.localDescription?.sdp;
      if (typeof sdp !== 'string' || !sdp.startsWith('v=0\r\n') || !sdp.includes('\nm=audio ')) throw Error('Could not create a valid microphone offer.');
      return sdp;
    } catch (error) {
      if (!s.cancelled && sessions.get(cmd.voiceId) === s) {
        release(s); sessions.delete(cmd.voiceId);
        window.voiceHost.error(cmd.voiceId, error?.message || 'Microphone capture failed.');
      }
      throw error;
    }
  }
  async function pttStart(cmd) {
    const old = ptt.get(cmd.voiceId);
    if (old) stopCapture(old);
    if (!navigator.mediaDevices?.getUserMedia) throw Error('Microphone capture is unavailable.');
    const audio = cmd.deviceId ? { deviceId: { exact: cmd.deviceId } } : true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const s = { stream, ctx: null, node: null, chunks: [], cancelled: false, sampleRate: 16000 };
    ptt.set(cmd.voiceId, s);
    window.voiceHost.state(cmd.voiceId, 'active');
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      s.ctx = ctx; s.sampleRate = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      s.node = node;
      node.onaudioprocess = e => {
        if (s.cancelled) return;
        s.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(node);
      node.connect(ctx.destination);
      return { ok: true, sampleRate: s.sampleRate };
    } catch (error) {
      stopCapture(s); ptt.delete(cmd.voiceId);
      throw error;
    }
  }
  function stopCapture(s) {
    if (!s || s.cancelled) return;
    s.cancelled = true;
    try { s.node?.disconnect(); } catch {}
    try { s.ctx?.close(); } catch {}
    s.stream?.getTracks().forEach(track => track.stop());
  }
  function encodeWav(chunks, sampleRate) {
    const count = chunks.reduce((a, c) => a + c.length, 0);
    const view = new DataView(new ArrayBuffer(44 + count * 2));
    const str = (off, text) => { for (let i = 0; i < text.length; i++) view.setUint8(off + i, text.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, count * 2, true);
    let off = 44;
    for (const chunk of chunks) for (let i = 0; i < chunk.length; i++, off += 2) {
      const v = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    const bytes = new Uint8Array(view.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function pttStop(cmd) {
    const s = ptt.get(cmd.voiceId);
    if (!s) throw Error('No push-to-talk capture is active.');
    stopCapture(s); ptt.delete(cmd.voiceId);
    return encodeWav(s.chunks, s.sampleRate);
  }
  async function speak(cmd) {
    if (typeof cmd.audioBase64 !== 'string' || !cmd.audioBase64) throw Error('Invalid speech audio.');
    const bin = atob(cmd.audioBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const audio = document.createElement('audio');
    audio.hidden = true; audio.playsInline = true; audio.src = url;
    document.body.appendChild(audio);
    const entry = { audio, done: null, cancelled: false };
    const done = new Promise(resolve => { entry.done = resolve; audio.onended = () => resolve(); });
    speaking = entry;
    try {
      await audio.play();
      await done;
    } catch (error) {
      if (speaking === entry) speaking = null;
      if (!entry.cancelled) throw Error('Spoken replies are enabled, but audio playback was blocked. Allow audio playback and try again.');
      return;
    } finally {
      if (speaking === entry) speaking = null;
      URL.revokeObjectURL(url); audio.remove();
    }
  }
  function speakCancel(cmd) {
    const entry = speaking;
    if (!entry) return;
    entry.cancelled = true;
    try { entry.audio.pause(); } catch {}
    entry.done?.();
  }
  async function command(name, cmd) {
    if (!cmd || typeof cmd.token !== 'string') return;
    try {
      let value;
      if (name === 'start') value = await start(cmd);
      else if (name === 'ptt-start') value = await pttStart(cmd);
      else if (name === 'ptt-stop') value = await pttStop(cmd);
      else if (name === 'speak') value = await speak(cmd);
      else if (name === 'speak-cancel') value = await speakCancel(cmd);
      else if (name === 'answer') {
        const s = sessions.get(cmd.voiceId);
        if (!s || s.cancelled || !s.pc) throw Error('No matching microphone session.');
        await s.pc.setRemoteDescription({ type: 'answer', sdp: cmd.sdp });
      } else if (name === 'playback') {
        const s = sessions.get(cmd.voiceId);
        if (!s || s.cancelled || typeof cmd.enabled !== 'boolean') throw Error('No matching microphone session.');
        await setPlayback(s, cmd.enabled);
      } else if (name === 'stop') {
        const s = sessions.get(cmd.voiceId);
        if (s) { release(s); sessions.delete(cmd.voiceId); }
        window.voiceHost.ended(cmd.voiceId);
      } else if (name === 'devices') {
        value = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput').map(d => ({ deviceId: d.deviceId, label: d.label }));
      }
      reply(cmd, value);
    } catch (error) { reply(cmd, undefined, error?.message || 'Microphone operation failed.'); }
  }
  window.voiceHost.listen((name, cmd) => { void command(name, cmd); });
  navigator.mediaDevices?.addEventListener?.('devicechange',()=>window.voiceHost.devicesChanged());
})();
