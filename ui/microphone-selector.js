(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MicrophoneSelector = api;
})(globalThis, function () {
  const defaultAliases = new Set(['default']);
  const communicationsAliases = new Set(['communications', 'default-communications', 'communications-default']);
  const aliases = new Set([...defaultAliases, ...communicationsAliases]);
  const priorities = { startup: 0, manual: 1, confirm: 2, devicechange: 3 };

  function normalizeDevices(input, previous = []) {
    if (!Array.isArray(input)) throw new TypeError('Microphone list is not available.');
    const prior = new Map(previous.map(device => [device.id, device]));
    const next = new Map();
    for (const raw of input) {
      if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
      const id = raw.id;
      if (aliases.has(id.trim().toLowerCase())) continue;
      const incoming = typeof raw.label === 'string' ? raw.label.trim() : '';
      const old = prior.get(id)?.label || '';
      const label = !incoming || incoming.toLowerCase() === 'microphone' ? old || incoming : incoming;
      if (!label) continue;
      const current = next.get(id);
      if (!current || current.label.toLowerCase() === 'microphone' && label.toLowerCase() !== 'microphone') next.set(id, { id, label });
    }
    return [...next.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  function isRedacted(input) {
    const endpoints = input.filter(raw => raw && typeof raw.id === 'string' && raw.id && !aliases.has(raw.id.trim().toLowerCase()));
    return endpoints.length > 0 && endpoints.every(raw => typeof raw.label !== 'string' || !raw.label.trim() || raw.label.trim().toLowerCase() === 'microphone');
  }

  function listCommunicationsAliases(input) {
    return [...new Set(input.filter(raw => raw && typeof raw.id === 'string' && communicationsAliases.has(raw.id.trim().toLowerCase())).map(raw => raw.id))];
  }

  function createMicrophoneSelector() {
    let devices = [];
    let communicationIds = [];
    let source = 'unverified';
    let issue = '';
    let pendingReason = null;
    let inFlight = null;

    const queue = reason => {
      if (!pendingReason || priorities[reason] > priorities[pendingReason]) pendingReason = reason;
    };
    const state = () => ({ devices: devices.map(device => ({ ...device })), source, issue });

    async function refreshOnce(load, reason) {
      try {
        const raw = await load();
        if (!Array.isArray(raw)) throw new TypeError('Microphone list is not available.');
        const listedCommunications = listCommunicationsAliases(raw);
        if (isRedacted(raw)) {
          if (listedCommunications.length) communicationIds = listedCommunications;
          source = devices.length ? 'cached' : 'unverified';
          issue = 'Microphone names are temporarily unavailable; keeping the last known choices.';
          return;
        }
        const listed = normalizeDevices(raw, devices);
        if (listed.length) {
          devices = listed;
          communicationIds = listedCommunications;
          source = 'ready';
          issue = '';
          return;
        }
        if (reason === 'confirm') {
          devices = [];
          communicationIds = listedCommunications;
          source = 'confirmed-empty';
          issue = '';
        } else if (reason === 'devicechange') {
          if (listedCommunications.length) communicationIds = listedCommunications;
          source = devices.length ? 'cached' : 'unverified';
          issue = 'Confirming the microphone list after a device change.';
          await new Promise(resolve => setTimeout(resolve, 200));
          queue('confirm');
        } else if (listedCommunications.length) {
          communicationIds = listedCommunications;
          source = devices.length ? 'cached' : 'unverified';
          issue = 'Only default microphone aliases were listed; named choices are retained when available.';
        } else if (source === 'confirmed-empty') {
          issue = '';
        } else if (devices.length) {
          source = 'cached';
          issue = 'The current microphone list was empty; showing the last known inputs.';
        } else {
          source = 'unverified';
          issue = 'No named microphone inputs were reported; Windows default input remains available.';
        }
      } catch (error) {
        source = devices.length ? 'cached' : 'unavailable';
        issue = error instanceof Error ? error.message : String(error || 'Microphone list could not be refreshed.');
      }
    }

    function refresh(load, reason = 'manual') {
      queue(reason in priorities ? reason : 'manual');
      if (inFlight) return inFlight;
      const task = Promise.resolve().then(async () => {
        while (pendingReason) {
          const nextReason = pendingReason;
          pendingReason = null;
          await refreshOnce(load, nextReason);
        }
        return state();
      });
      inFlight = task.finally(() => {
        inFlight = null;
        if (pendingReason) void refresh(load, pendingReason);
      });
      return inFlight;
    }

    function view(savedId = '') {
      const saved = typeof savedId === 'string' ? savedId : '';
      const savedKey = saved.trim().toLowerCase();
      const savedIsDefault = defaultAliases.has(savedKey);
      const savedIsCommunications = communicationsAliases.has(savedKey);
      const selected = savedIsDefault ? '' : saved;
      const options = [{ value: '', label: 'Windows default input' }, ...devices.map(({ id, label }) => ({ value: id, label }))];
      const savedCommunicationsAvailable = savedIsCommunications && communicationIds.includes(saved);
      const savedAvailable = !saved || savedIsDefault || savedCommunicationsAvailable || devices.some(device => device.id === saved);
      if (savedCommunicationsAvailable) options.push({ value: saved, label: 'Communications default' });
      else if (saved && !savedAvailable) options.push({ value: saved, label: savedIsCommunications ? 'Saved communications default unavailable' : 'Saved microphone unavailable' });
      let note;
      if (source === 'ready') note = `${devices.length} named microphone input${devices.length === 1 ? '' : 's'} available.`;
      else if (source === 'cached') note = issue ? `${issue} Last known microphone choices are retained.` : 'Showing the last known microphone choices.';
      else if (source === 'confirmed-empty') note = 'No named microphone inputs are connected; Windows default input remains available.';
      else if (source === 'unavailable') note = `Microphone list could not be refreshed: ${issue}. Windows default input remains available.`;
      else note = issue || 'No named microphone inputs have been confirmed; Windows default input remains available.';
      if (saved && !savedAvailable) note += ' The saved microphone is unavailable; choose Windows default or another listed input.';
      return {
        options,
        selected,
        note,
        signature: JSON.stringify([options, saved]),
        source,
        issue,
        devices: devices.map(device => ({ ...device })),
        communicationIds: [...communicationIds],
      };
    }

    return { refresh, state, view };
  }

  function syncSelect(select, view, activeElement, makeOption = (label, value) => new Option(label, value)) {
    if (select.dataset.microphoneSignature === view.signature) return false;
    const wasFocused = activeElement === select;
    select.replaceChildren(...view.options.map(option => makeOption(option.label, option.value)));
    select.value = view.selected;
    select.dataset.microphoneSignature = view.signature;
    if (wasFocused) select.focus({ preventScroll: true });
    return true;
  }

  return { createMicrophoneSelector, normalizeDevices, syncSelect };
});
