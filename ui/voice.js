'use strict';
(() => {
  const sessions = new Map();
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
  async function command(name, cmd) {
    if (!cmd || typeof cmd.token !== 'string') return;
    try {
      let value;
      if (name === 'start') value = await start(cmd);
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
