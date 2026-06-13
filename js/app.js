// ── Global mode state ────────────────────────────────────────────────
let currentMode = null;
const caps = { usb: !!navigator.usb, serial: !!navigator.serial };

// ── Mode routing ─────────────────────────────────────────────────────
function switchMode(mode) {
  // Wizard modes require both APIs. Redirect to expert if one is missing.
  if ((mode === 'update' || mode === 'newboard') && (!caps.usb || !caps.serial)) {
    mode = 'expert';
  }

  currentMode = mode;
  history.replaceState(null, '', '#' + mode);

  $('modeSelector').style.display   = 'none';
  $('expertLayout').style.display   = mode === 'expert' ? '' : 'none';
  $('wizardLayout').style.display   = (mode === 'update' || mode === 'newboard') ? '' : 'none';

  if (mode === 'expert') {
    if (!caps.usb && caps.serial) {
      // Only serial: lock to ECU B/C/D, hide target picker (no choice to make)
      $('ecuTargetCard').style.display = 'none';
      setEcuTarget('BCD');
    } else if (caps.usb && !caps.serial) {
      // Only USB: lock to ECU A, hide target picker
      $('ecuTargetCard').style.display = 'none';
      setEcuTarget('A');
    } else {
      $('ecuTargetCard').style.display = '';
      setEcuTarget('both');
    }
    restoreCollapsibleState();
  }
  if (mode === 'update') {
    $('wizModeLabel').textContent = 'Update RAMN';
    showWizSetup('update');
  }
  if (mode === 'newboard') {
    $('wizModeLabel').textContent = 'First-Time Setup / Recovery';
    showWizSetup('newboard');
  }
}

function showModeSelector() {
  currentMode = null;
  $('modeSelector').style.display   = '';
  $('expertLayout').style.display   = 'none';
  $('wizardLayout').style.display   = 'none';
}

// ── Wizard phase helpers ─────────────────────────────────────────────
function showWizSetup(mode) {
  $('wizSetupUpdate').style.display   = mode === 'update'   ? '' : 'none';
  $('wizSetupNewboard').style.display = mode === 'newboard' ? '' : 'none';
  $('wizFlashPhase').style.display    = 'none';
  // Always reset to the GitHub default and sync all conditional UI, so
  // the form is consistent regardless of what was selected previously.
  if (mode === 'update') {
    const radio = document.querySelector('input[name="wizFwSource"][value="gh"]');
    if (radio) { radio.checked = true; onWizSourceChange(radio); }
  }
  if (mode === 'newboard') {
    const radio = document.querySelector('input[name="wizNbFwSource"][value="gh"]');
    if (radio) { radio.checked = true; onWizNbSourceChange(radio); }
    // Reset variant to standard firmware — CTF variants from update mode must not carry over
    const varSel = $('wizVariantSelect');
    if (varSel) {
      const first = varSel.options[0];
      if (first) { varSel.value = first.value; onWizVariantChange(); }
    }
  }
}

function showWizFlash() {
  $('wizSetupUpdate').style.display   = 'none';
  $('wizSetupNewboard').style.display = 'none';
  $('wizFlashPhase').style.display    = '';
  $('wizStepList').innerHTML          = '';
  $('wizProgressWrap').style.display  = 'none';
  $('wizDoneActions').style.display   = 'none';
  // Shared with both done screens; runUpdateFlash re-shows it for CTF flashes,
  // runNewBoardFlash never does — reset here so CTF links can't leak across flashes.
  $('wizCtfDoneLinks').style.display  = 'none';
  $('wizLogArea').style.display       = 'none';
  $('btnWizLog').textContent          = 'Show log';
  $('btnWizStartOver').disabled       = true;
}

// ── Wizard log toggle ────────────────────────────────────────────────
function toggleWizLog() {
  const area = $('wizLogArea');
  const btn  = $('btnWizLog');
  const hidden = area.style.display === 'none';
  area.style.display = hidden ? '' : 'none';
  btn.textContent = hidden ? 'Hide log' : 'Show log';
}

// ── Wizard start over ────────────────────────────────────────────────
// Full page reload guarantees a clean slate — it clears every firmware buffer,
// the file-input selection (so re-picking the same local files fires a fresh
// change event), all device handles, and the wizard DOM. This avoids the whole
// class of stale-state bugs that piecemeal resets miss. The wizard mode is
// persisted in localStorage + the URL hash, so the reload returns the user to
// the same mode's setup screen.
async function wizStartOver() {
  // Release device handles cleanly before reload so the OS frees the ports.
  try { if (serConnected) await doDisconnectSerial(); } catch (e) {}
  try { if (usbDev)       await doDisconnect();       } catch (e) {}
  location.reload();
}

// ── Wizard source radios ─────────────────────────────────────────────
function onWizSourceChange(radio) {
  const src = radio.value;
  const ghAdv  = $('wizGhAdvanced');
  const filePk = $('wizFilePicker');
  if (ghAdv)  ghAdv.style.display  = src === 'gh'   ? '' : 'none';
  if (filePk) filePk.style.display = src === 'file' ? '' : 'none';
  if (src === 'gh') syncWizVariant();
  if (src === 'file') {
    clearAllFw();
  } else {
    // Switching away from file: re-enable the log checkbox so the user
    // can choose freely (the remote fetch will provide both variants).
    const el = $('wizChkLog');
    if (el) el.disabled = false;
  }
  ['gh','rel','file'].forEach(v => {
    const el = $('wiz-opt-' + v);
    if (el) el.classList.toggle('wiz-radio-selected', v === src);
  });
  updateWizCtfLogUI();
  updateWizFlashButtons();
}

function onWizNbSourceChange(radio) {
  const src = radio.value;
  const filePk = $('wizNbFilePicker');
  if (filePk) filePk.style.display = src === 'file' ? '' : 'none';
  if (src === 'file') {
    clearAllFw();
  } else {
    const el = $('wizNbChkLog');
    if (el) el.disabled = false;
  }
  ['gh','rel','file'].forEach(v => {
    const el = $('wizNb-opt-' + v);
    if (el) el.classList.toggle('wiz-radio-selected', v === src);
  });
  updateWizFlashButtons();
}

// ── Validate wizard firmware completeness ────────────────────────────
function updateWizFlashButtons() {
  const mode = currentMode;
  if (mode !== 'update' && mode !== 'newboard') return;

  const isUpdate   = mode === 'update';
  const srcName    = isUpdate ? 'wizFwSource' : 'wizNbFwSource';
  const srcRadio   = document.querySelector(`input[name="${srcName}"]:checked`);
  const src        = srcRadio ? srcRadio.value : 'gh';
  const btnId      = isUpdate ? 'btnWizFlashUpdate'  : 'btnWizFlashNewboard';
  const errId      = isUpdate ? 'wizUpdateErr'        : 'wizNewboardErr';
  const btn = $(btnId), errEl = $(errId);
  if (!btn) return;

  if (src !== 'file') {
    // Remote fetch will get everything — always enabled
    btn.disabled = false;
    if (errEl) errEl.style.display = 'none';
    return;
  }

  // File source: check all four ECUs are covered
  const missing = [];
  if (!fwBuf)                    missing.push('ECU A');
  if (!fwBufB && !fwBufBLinear)  missing.push('ECU B');
  if (!fwBufC)                   missing.push('ECU C');
  if (!fwBufD)                   missing.push('ECU D');

  if (missing.length === 4) {
    // Nothing loaded yet — neutral state, button disabled, no error shown
    btn.disabled = true;
    if (errEl) errEl.style.display = 'none';
    return;
  }

  if (missing.length > 0) {
    btn.disabled = true;
    if (errEl) {
      errEl.style.display = '';
      errEl.innerHTML = `Missing firmware for <b>${missing.join(', ')}</b>. `
        + 'To flash individual ECUs, use '
        + '<button class="btn-link" onclick="switchMode(\'expert\')">Expert Mode</button>.';
    }
  } else {
    btn.disabled = false;
    if (errEl) errEl.style.display = 'none';
  }
}

function toggleWizAdvanced() {
  const body = $('wizGhAdvBody');
  const btn  = $('wizGhAdvBtn');
  const open = body.style.display === 'none';
  body.style.display = open ? '' : 'none';
  btn.textContent = open ? 'Advanced ▴' : 'Advanced ▾';
  if (open) syncWizVariant();
}

function syncWizVariant() {
  // Populate wizard variant select from the shared #fwDirSelect, preserving optgroups
  const src = $('fwDirSelect'), dst = $('wizVariantSelect');
  if (!src || !dst || src.options.length === 0) return;
  const cur = dst.value;
  dst.innerHTML = '';
  for (const child of src.children) {
    if (child.tagName === 'OPTGROUP') {
      const grp = document.createElement('optgroup');
      grp.label = child.label;
      for (const opt of child.children) {
        const o = document.createElement('option');
        o.value = opt.value; o.textContent = opt.textContent;
        grp.appendChild(o);
      }
      dst.appendChild(grp);
    } else {
      const o = document.createElement('option');
      o.value = child.value; o.textContent = child.textContent;
      dst.appendChild(o);
    }
  }
  dst.value = cur;
}

function onWizVariantChange() {
  // Mirror selected variant to the shared #fwDirSelect used by fetchFw()
  const dst = $('wizVariantSelect'), src = $('fwDirSelect');
  if (src && dst) src.value = dst.value;
  updateWizCtfLogUI();
}

// Hide the wizard's logarithmic option only when GitHub source + CTF variant is
// selected. CTF firmware has no linear/log variant, but only the GitHub source can
// flash CTF — so Latest release / Custom keep the option visible even if the
// (GitHub-only) variant select still holds a stale ctf: value.
function updateWizCtfLogUI() {
  const srcRadio = document.querySelector('input[name="wizFwSource"]:checked');
  const src = srcRadio ? srcRadio.value : 'gh';
  const variant = $('wizVariantSelect') ? $('wizVariantSelect').value : '';
  const isCTF = src === 'gh' && variant.startsWith('ctf:');
  const wizItem = $('wizChkLogItem');
  if (wizItem) wizItem.style.display = isCTF ? 'none' : '';
}

// ── Collect wizard setup options ─────────────────────────────────────
function readWizOpts(mode) {
  if (mode === 'update') {
    const src = document.querySelector('input[name="wizFwSource"]:checked');
    return {
      fwSource:    src ? src.value : 'gh',
      logarithmic: $('wizChkLog').checked,
      skipVerify:  $('wizChkSkipVerify').checked,
      variant:     ($('wizVariantSelect') && $('wizVariantSelect').value) || '',
    };
  } else {
    const src = document.querySelector('input[name="wizNbFwSource"]:checked');
    return {
      fwSource:    src ? src.value : 'gh',
      logarithmic: $('wizNbChkLog').checked,
      skipVerify:  $('wizNbChkSkipVerify').checked,
      variant:     '',
    };
  }
}

// ── CTF log-option visibility ────────────────────────────────────────
function updateCtfLogUI() {
  // Entry point called from firmware.js's onDirChange. The expert #chkBLogWrap is
  // governed authoritatively by syncFwCheckboxes (firmware presence), so only the
  // wizard log option needs re-evaluating here.
  updateWizCtfLogUI();
}

// ── CTF confirmation modal ───────────────────────────────────────────
function showCTFModal(ctfName, onConfirm) {
  $('ctfModalName').textContent = ctfName.replace(/_/g, ' ');
  $('ctfModal').style.display = '';
  $('ctfModalCancel').onclick  = () => { $('ctfModal').style.display = 'none'; };
  $('ctfModalConfirm').onclick = () => { $('ctfModal').style.display = 'none'; onConfirm(); };
}

// ── Start flash from wizard ──────────────────────────────────────────
function startWizardFlash(mode) {
  const opts = readWizOpts(mode);
  const variantVal = $('wizVariantSelect') ? $('wizVariantSelect').value : '';
  // Only the GitHub source can flash CTF firmware — don't show the modal when
  // the variant select still holds a stale ctf: value but rel/file is chosen.
  if (opts.fwSource === 'gh' && variantVal.startsWith('ctf:')) {
    showCTFModal(variantVal.slice(4), () => {
      showWizFlash();
      if (mode === 'update') runUpdateFlash(opts);
      else                   runNewBoardFlash(opts);
    });
  } else {
    showWizFlash();
    if (mode === 'update') runUpdateFlash(opts);
    else                   runNewBoardFlash(opts);
  }
}

// ── Collapsible sections (expert mode) ───────────────────────────────
function toggleSection(cardId) {
  const card = $(cardId);
  if (!card) return;
  const collapsed = card.classList.toggle('collapsed');
  localStorage.setItem('ramn-collapsed-' + cardId, collapsed ? '1' : '0');
}

function restoreCollapsibleState() {
  ['fwFullCard','ecuTargetCard','howToCard','secACard','secBCDCard'].forEach(id => {
    const card = $(id);
    if (!card) return;
    const stored = localStorage.getItem('ramn-collapsed-' + id);
    if (stored === '1') card.classList.add('collapsed');
    else                card.classList.remove('collapsed');
  });
}

// ── Help modal ────────────────────────────────────────────────────────
function openModal(tabId) {
  $('helpModal').style.display = '';
  switchTab(tabId);
}

function closeModal() {
  $('helpModal').style.display = 'none';
}

function switchTab(tabId) {
  [
    { id:'ecuBType', btn:'tabEcuBType', content:'contentEcuBType' },
    { id:'browser',  btn:'tabBrowser',  content:'contentBrowser'  },
  ].forEach(({ id, btn, content }) => {
    const b = $(btn), c = $(content);
    if (b) b.classList.toggle('active', id === tabId);
    if (c) c.style.display = id === tabId ? '' : 'none';
  });
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Init ─────────────────────────────────────────────────────────────
(function init() {
  // Apply mode selector state based on API availability
  if (!caps.usb || !caps.serial) {
    const w = $('msWarning');
    w.style.display = '';
    if (!caps.usb && !caps.serial) {
      w.textContent = 'WebUSB and Web Serial are not available. Chrome or Edge 89+ is required.';
    } else if (!caps.usb) {
      w.textContent = 'WebUSB is not available — ECU A (DFU) cannot be flashed. Wizard modes are disabled; use Expert Mode for ECU B/C/D.';
    } else {
      w.textContent = 'Web Serial is not available — ECU B/C/D cannot be flashed. Wizard modes are disabled; use Expert Mode for ECU A.';
    }

    // Disable wizard mode cards on the selector — they require both APIs
    const unavailDesc = !caps.usb
      ? 'Requires WebUSB, which is not available in this browser.'
      : 'Requires Web Serial, which is not available in this browser.';
    ['btnMsUpdate', 'btnMsNewboard'].forEach(id => {
      const card = $(id);
      if (!card) return;
      card.classList.add('ms-card-unavailable');
      const desc = card.querySelector('.ms-card-desc');
      if (desc) desc.textContent = unavailDesc;
    });
  }

  const params = new URLSearchParams(location.search);
  const ctfParam = params.get('ctf');
  if (ctfParam && /^[\w-]+$/.test(ctfParam)) {
    pendingCtfVariant = ctfParam;
  }

  const hash = location.hash.replace('#', '');
  // ?ctf= forces Update mode (the only wizard that supports CTF auto-flash)
  const mode = pendingCtfVariant ? 'update'
    : (['expert','update','newboard'].includes(hash) ? hash : null);

  if (mode === 'expert' || mode === 'update' || mode === 'newboard') {
    switchMode(mode);
  } else {
    showModeSelector();
  }
})();
