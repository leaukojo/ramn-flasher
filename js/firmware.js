// ── Firmware source ────────────────────────────────────────────────────────
const CONTENTS_API    ='https://api.github.com/repos/ToyotaInfoTech/RAMN/contents/scripts/firmware';
const CTF_CONTENTS_API='https://api.github.com/repos/ToyotaInfoTech/RAMN/contents/misc/past_CTFs';
const FW_RAW_BASE     ='https://raw.githubusercontent.com/ToyotaInfoTech/RAMN/main/scripts/firmware';
const FW_RAW_BASE_CTF ='https://raw.githubusercontent.com/ToyotaInfoTech/RAMN/main/misc/past_CTFs';
const RELEASES_API    ='https://api.github.com/repos/ToyotaInfoTech/RAMN/releases/latest';
let fwDirsLoaded=false;

// Reset all firmware buffers, the CTF flag, and the per-ECU status lines.
// `text`/`color` set the displayed status for each ECU row.
function resetFwBuffers(text='No firmware loaded',color=''){
  fwBuf=fwBufB=fwBufBLinear=fwBufC=fwBufD=null;
  ctfVariant=null;
  ['A','B','C','D'].forEach(l=>setEcuFwStatus(l,text,color));
}

function clearAllFw(){
  resetFwBuffers();
  updateFlashBtn();syncFwCheckboxes();
}
function clearFetchedFw(){$('fetchStatus').textContent='';clearAllFw();}
function clearRelFw(){$('relStatus').textContent='';clearAllFw();}
function clearDirFw(){$('canDirInput').value='';clearAllFw();}

function setFwSource(src){
  $('fwGhPanel').style.display  = src==='gh'  ? '' : 'none';
  $('fwRelPanel').style.display = src==='rel' ? '' : 'none';
  $('fwFilePanel').style.display= src==='file'? '' : 'none';
  [['gh','btnSrcGh'],['rel','btnSrcRel'],['file','btnSrcFile']].forEach(([s,id])=>{
    $(id).className='btn btn-sm '+(s===src?'btn-primary':'btn-ghost');
  });
  if(src==='file'){ clearFetchedFw(); clearRelFw(); }
  if(src==='gh')  { clearRelFw();     clearDirFw(); loadFwDirs(); }
  if(src==='rel') { clearFetchedFw(); clearDirFw(); }
}

async function loadFwDirs(){
  if(fwDirsLoaded){onDirChange();return;}
  const sel=$('fwDirSelect');
  sel.innerHTML='<option value="">Loading…</option>';
  try{
    const [stdItems,ctfItems]=await Promise.all([
      fetch(CONTENTS_API).then(r=>{if(!r.ok)throw new Error(`API ${r.status}`);return r.json();}),
      fetch(CTF_CONTENTS_API).then(r=>r.ok?r.json():[]).catch(()=>[])
    ]);
    const stdDirs=stdItems.filter(i=>i.type==='dir').map(i=>i.name).sort();
    const ctfDirs=ctfItems.filter(i=>i.type==='dir').map(i=>i.name).sort();
    let html='<option value="">Standard</option>'+stdDirs.map(d=>`<option value="${esc(d)}">${esc(d)}</option>`).join('');
    if(ctfDirs.length>0){
      html+='<optgroup label="⚠ CTF Firmware">'+ctfDirs.map(d=>`<option value="ctf:${esc(d)}">${esc(d)}</option>`).join('')+'</optgroup>';
    }
    sel.innerHTML=html;
    fwDirsLoaded=true;
    if(pendingCtfVariant){
      const targetVal=`ctf:${pendingCtfVariant}`;
      if(sel.querySelector(`option[value="${targetVal}"]`)){
        sel.value=targetVal;
        pendingCtfVariant=null;
        onDirChange(); // updates path hint, hides log checkbox
        // Sync to wizard variant select and auto-open the Advanced panel so the user sees it
        syncWizVariant();
        const wizSel=$('wizVariantSelect');
        if(wizSel) wizSel.value=targetVal;
        const advBody=$('wizGhAdvBody');
        const advBtn=$('wizGhAdvBtn');
        if(advBody&&advBody.style.display==='none'){
          advBody.style.display='';
          if(advBtn) advBtn.textContent='Advanced ▴';
        }
        return; // onDirChange already called above
      }
      pendingCtfVariant=null;
    }
  }catch(e){
    sel.innerHTML='<option value="">Standard (offline fallback)</option>';
    log(`Could not load variant list: ${e.message}`,'log-warn');
  }
  onDirChange();
}

function onDirChange(){
  const dir=$('fwDirSelect').value;
  const isCTF=dir.startsWith('ctf:');
  // Note: ctfVariant is NOT set here. It reflects what was actually fetched
  // (set in fetchFw), so the post-flash CTF warning can't leak across flashes.
  $('fwDirPath').textContent=isCTF
    ?`misc/past_CTFs/${dir.slice(4)}/firmware/ECU[A-D].hex · main branch`
    :'scripts/firmware/'+(dir?`${dir}/`:'')+'ECU[A-D].bin/.hex · main branch';
  if(typeof updateCtfLogUI==='function') updateCtfLogUI();
  if(typeof updateExpertCtfWarning==='function') updateExpertCtfWarning();
  clearAllFw();$('fetchStatus').textContent='';
}

// Shared ECU A + B/C/D fetch used by both fetchFw and fetchRelease. `base` is the
// firmware directory URL. Options:
//   preferBin   — try ECUA.bin then fall back to .hex (false = .hex only)
//   fetchLinear — also try ECUB_LINEAR.hex
//   statusColor — colour for the per-ECU status lines
//   logSuffix   — appended to each fetch log line (e.g. "[Standard]" or "from release v1.2")
//   logClass    — log style for the fetch lines ('log-ok' | 'log-warn')
// Sets fwBuf/fwBufB/fwBufBLinear/fwBufC/fwBufD and the status lines; returns {ok}
// (count of B/C/D found). Throws if ECU A cannot be fetched.
async function fetchEcuSet(base,{preferBin,fetchLinear,statusColor,logSuffix,logClass}){
  // ECU A
  let resp,isHex=false;
  if(preferBin){
    resp=await fetch(`${base}/ECUA.bin`);
    if(!resp.ok){resp=await fetch(`${base}/ECUA.hex`);isHex=true;if(!resp.ok)throw new Error(`HTTP ${resp.status}`);}
  }else{
    resp=await fetch(`${base}/ECUA.hex`);isHex=true;
    if(!resp.ok)throw new Error(`HTTP ${resp.status}`);
  }
  fwBuf=isHex?parseIntelHex(await resp.text()):await resp.arrayBuffer();
  const fnameA=isHex?'ECUA.hex':'ECUA.bin';
  setEcuFwStatus('A',`${fnameA}  ${(fwBuf.byteLength/1024).toFixed(1)} KiB`,statusColor);
  log(`Fetched ${fnameA} ${logSuffix}`,logClass);
  // ECU B/C/D
  let ok=0;
  for(const letter of['B','C','D']){
    try{
      const r=await fetch(`${base}/ECU${letter}.hex`);
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const buf=parseIntelHex(await r.text());
      if(letter==='B'){
        fwBufB=buf;
        setEcuFwStatus('B',`ECUB.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,statusColor);
        if(fetchLinear){
          try{
            const rl=await fetch(`${base}/ECUB_LINEAR.hex`);
            if(!rl.ok)throw new Error(`HTTP ${rl.status}`);
            fwBufBLinear=parseIntelHex(await rl.text());
            log(`Fetched ECUB_LINEAR.hex ${logSuffix}`,'log-ok');
            setEcuFwStatus('B',`ECUB.hex + ECUB_LINEAR.hex`,statusColor);
          }catch(e){fwBufBLinear=null;}
        }
      }else if(letter==='C'){fwBufC=buf;setEcuFwStatus('C',`ECUC.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,statusColor);}
      else{fwBufD=buf;setEcuFwStatus('D',`ECUD.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,statusColor);}
      log(`Fetched ECU${letter}.hex ${logSuffix}`,logClass); ok++;
    }catch(e){setEcuFwStatus(letter,'Not found','var(--muted)');log(`ECU${letter}: ${e.message}`,'log-warn');}
  }
  return {ok};
}

async function fetchRelease(){
  const btn=$('btnFetchRel'),st=$('relStatus');
  btn.disabled=true; st.textContent='Fetching…'; st.style.color='var(--muted)';
  resetFwBuffers('…','var(--muted)');
  try{
    const meta=await fetch(RELEASES_API).then(r=>{if(!r.ok)throw new Error(`API ${r.status}`);return r.json();});
    const tag=meta.tag_name;
    if(!/^[\w][\w.\-/]*[\w]$/.test(tag)||tag.includes('..'))throw new Error(`Unexpected tag name: ${tag}`);
    // Fetch from raw.githubusercontent.com at the release tag — release-assets CDN has no CORS headers
    const base=`https://raw.githubusercontent.com/ToyotaInfoTech/RAMN/${tag}/scripts/firmware`;
    const {ok}=await fetchEcuSet(base,{preferBin:true,fetchLinear:true,statusColor:'var(--success)',logSuffix:`from release ${tag}`,logClass:'log-ok'});
    st.textContent=`✓ ${tag}  ECU A + ${ok}/3 B/C/D`; st.style.color='var(--success)';
  }catch(e){
    st.textContent=`Error: ${e.message}`; st.style.color='var(--danger)';
    log(`Release fetch failed: ${e.message}`,'log-err'); fwBuf=null;
    setEcuFwStatus('A','Error','var(--danger)');
  }finally{btn.disabled=false; updateFlashBtn(); syncFwCheckboxes();}
}

async function fetchFw(){
  const btn=$('btnFetch'),st=$('fetchStatus');
  btn.disabled=true; st.textContent='Fetching…'; st.style.color='var(--muted)';
  resetFwBuffers('…','var(--muted)');
  try{
    const dir=$('fwDirSelect').value;
    const isCTF=dir.startsWith('ctf:');
    let base,label,statusColor;
    if(isCTF){
      const ctfName=dir.slice(4);
      if(!/^[\w-]+$/.test(ctfName))throw new Error(`Unexpected CTF name: ${ctfName}`);
      base=`${FW_RAW_BASE_CTF}/${ctfName}/firmware`;
      label=ctfName; statusColor='var(--warning)';
    } else {
      if(dir&&!/^[\w-]+$/.test(dir))throw new Error(`Unexpected variant name: ${dir}`);
      base=dir?`${FW_RAW_BASE}/${dir}`:FW_RAW_BASE;
      label=dir||'Standard'; statusColor='var(--success)';
    }
    // CTF firmware is .hex-only and has no linear ECU B variant.
    const {ok}=await fetchEcuSet(base,{preferBin:!isCTF,fetchLinear:!isCTF,statusColor,logSuffix:`[${label}]`,logClass:isCTF?'log-warn':'log-ok'});
    // Record the CTF variant that was actually loaded (drives the post-flash warning).
    if(isCTF) ctfVariant=label;
    const prefix=isCTF?'⚠':'✓';
    st.textContent=`${prefix} [${label}]  ECU A + ${ok}/3 B/C/D`; st.style.color=statusColor;
  }catch(e){
    st.textContent=`Error: ${e.message}`; st.style.color='var(--danger)';
    log(`Fetch failed: ${e.message}`,'log-err'); fwBuf=null;
    setEcuFwStatus('A','Error','var(--danger)');
  }finally{btn.disabled=false; updateFlashBtn(); syncFwCheckboxes();}
}

// ── Local file picker ──────────────────────────────────────────────────────
// Read one picked File, resolving to its text (asText) or ArrayBuffer.
function readFile(file,asText){
  return new Promise(res=>{
    const r=new FileReader();
    r.onload=()=>res(r.result);
    asText?r.readAsText(file):r.readAsArrayBuffer(file);
  });
}

$('canDirInput').addEventListener('change',async e=>{
  const files=[...e.target.files];
  resetFwBuffers('Not selected','var(--muted)');
  // ECU A: prefer .bin, fall back to .hex
  const fA=files.find(f=>f.name==='ECUA.bin')||files.find(f=>f.name==='ECUA.hex');
  const fBHex=files.find(f=>f.name==='ECUB.hex');
  const fBLinear=files.find(f=>f.name==='ECUB_LINEAR.hex');
  const fC=files.find(f=>f.name==='ECUC.hex');
  const fD=files.find(f=>f.name==='ECUD.hex');
  if(!(fA||fBHex||fBLinear||fC||fD)){syncFwCheckboxes();return;}
  if(fA){
    const isHex=fA.name.endsWith('.hex');
    const data=await readFile(fA,isHex);
    fwBuf=isHex?parseIntelHex(data):data;
    setEcuFwStatus('A',`${fA.name}  ${(fwBuf.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
    log(`Loaded ${fA.name}  ${(fwBuf.byteLength/1024).toFixed(1)} KiB`,'log-ok');
    updateFlashBtn();
  }
  if(fBHex){
    fwBufB=parseIntelHex(await readFile(fBHex,true));
    setEcuFwStatus('B',`ECUB.hex  ${(fwBufB.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
    log(`Loaded ECUB.hex  ${(fwBufB.byteLength/1024).toFixed(1)} KiB`,'log-ok');
  }
  if(fBLinear){
    fwBufBLinear=parseIntelHex(await readFile(fBLinear,true));
    log(`Loaded ECUB_LINEAR.hex  ${(fwBufBLinear.byteLength/1024).toFixed(1)} KiB`,'log-ok');
  }
  for(const [f,letter] of[[fC,'C'],[fD,'D']]){
    if(!f)continue;
    const buf=parseIntelHex(await readFile(f,true));
    if(letter==='C')fwBufC=buf;else fwBufD=buf;
    setEcuFwStatus(letter,`ECU${letter}.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
    log(`Loaded ECU${letter}.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,'log-ok');
  }
  // Reconcile ECU B status with which variants ended up loaded.
  if(fwBufB&&fwBufBLinear)      setEcuFwStatus('B','ECUB.hex + ECUB_LINEAR.hex','var(--success)');
  else if(!fwBufB&&fwBufBLinear) setEcuFwStatus('B',`ECUB_LINEAR.hex  ${(fwBufBLinear.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
  syncFwCheckboxes();
});

// Default to GitHub source on load
setFwSource('gh');
