// ── Descriptor parsing ────────────────────────────────────────────────────
// parseExtras and parsePageSize live in protocol.js (pure helpers).

// Chrome sometimes puts the DFU functional descriptor in alt.extras and sometimes
// in ifc.extras — try both.
function parseFuncDesc(alt, ifc){
  return parseExtras(alt&&alt.extras) || parseExtras(ifc&&ifc.extras) || null;
}

// ── WebUSB connect / disconnect ───────────────────────────────────────────
async function doConnect(){
  const vid=0x0483,pid=0xDF11,cfgNum=1,altNum=0;
  try{
    usbDev=await navigator.usb.requestDevice({filters:[{vendorId:vid,productId:pid}]});
    await usbDev.open();
    log(`Opened: ${usbDev.manufacturerName||'?'} / ${usbDev.productName||'?'}`,'log-ok');
    log(`VID:PID ${hex(usbDev.vendorId,4)}:${hex(usbDev.productId,4)}  serial=${usbDev.serialNumber||'n/a'}`,'log-info');
    await usbDev.selectConfiguration(cfgNum);

    let foundIface=null;
    for(const cfg of usbDev.configurations)
      for(const ifc of cfg.interfaces)
        for(const alt of ifc.alternates)
          if(alt.interfaceClass===0xFE&&alt.interfaceSubclass===0x01){
            log(`  DFU iface=${ifc.interfaceNumber} alt=${alt.alternateSetting} proto=${alt.interfaceProtocol} name="${alt.interfaceName||''}"`, 'log-info');
            if(alt.alternateSetting===altNum&&!foundIface) foundIface={ifc,alt};
          }

    if(!foundIface) throw new Error(`No DFU interface for alt=${altNum}`);
    dfuIface=foundIface.ifc;

    const fd=parseFuncDesc(foundIface.alt, foundIface.ifc);
    if(fd){
      xferSize=fd.wTransferSize||1024;
      log(`FuncDesc: wTransferSize=${xferSize} bcdDFU=${hex(fd.bcdDFU,4)} bmAttr=${hex(fd.bmAttr,2)}`,'log-info');
      $('devInfo').style.display='';
      $('infoXfer').textContent=xferSize+' B';
      $('infoBcd').textContent=hex(fd.bcdDFU,4);
      $('infoAttr').textContent=hex(fd.bmAttr,2);
    } else {
      xferSize=1024; // reset to default so a value from a prior device can't carry over
      log(`No functional descriptor — using xferSize=${xferSize}`,'log-warn');
    }

    const altName=foundIface.alt.interfaceName||'';
    $('infoAlt').textContent=altName||'—';
    if(altName) log(`Alt name: "${altName}"`,'log-info');

    pageSize=parsePageSize(altName, FLASH_BASE_ADDR) || 2048;
    log(`Page size: ${pageSize} bytes`,'log-info');

    await usbDev.claimInterface(dfuIface.interfaceNumber);
    await usbDev.selectAlternateInterface(dfuIface.interfaceNumber,altNum);
    log(`Interface ${dfuIface.interfaceNumber} claimed ✓`,'log-ok');

    setDevUI(true,
      `${usbDev.manufacturerName||'?'} / ${usbDev.productName||'?'}`,
      `${hex(usbDev.vendorId,4)}:${hex(usbDev.productId,4)} — iface ${dfuIface.interfaceNumber}`);
    setSt('Connected','Ready','ok');
    $('btnConnect').classList.remove('btn-hint');
    $('connectFailMsg').style.display='none';
    $('triggerBanner').style.display='none';
  }catch(e){
    log(`Connect failed: ${e.message}`,'log-err');
    setSt('Error',e.message,'err');
    usbDev=null;dfuIface=null;
    setDevUI(false,'No device connected','—');
    $('btnConnect').classList.remove('btn-hint');
    $('connectFailMsg').style.display='';
    if(e.name==='NotFoundError') $('btnTriggerDFU').classList.add('btn-hint');
  }
}

async function doDisconnect(){
  try{if(dfuIface)await usbDev.releaseInterface(dfuIface.interfaceNumber)}catch(e){}
  try{await usbDev.close()}catch(e){}
  usbDev=null;dfuIface=null;
  setDevUI(false,'No device connected','—');
  $('devInfo').style.display='none';
  setSt('Idle','Connect a device to begin');
  log('Disconnected','log-warn');
}

// ── Raw USB class transfers ───────────────────────────────────────────────
// All data arguments must be ArrayBuffer (not TypedArray) to avoid
// Chrome WebUSB sending the full backing buffer instead of the slice.

async function rawOut(req, val, ab){
  if(!usbDev||!dfuIface) throw new Error('Device disconnected during flash');
  const r=await usbDev.controlTransferOut({
    requestType:'class', recipient:'interface',
    request:req, value:val, index:dfuIface.interfaceNumber
  }, ab);
  return r.status; // 'ok' | 'stall' | 'babble'
}

async function rawIn(req, val, len){
  if(!usbDev||!dfuIface) throw new Error('Device disconnected during flash');
  const r=await usbDev.controlTransferIn({
    requestType:'class', recipient:'interface',
    request:req, value:val, index:dfuIface.interfaceNumber
  }, len);
  if(r.status!=='ok') throw new Error(`ctrlIn stall/err req=${req} status=${r.status}`);
  return r.data; // DataView
}

// ── DFU protocol ──────────────────────────────────────────────────────────
async function getstatus(){
  const d=await rawIn(DFU_GETSTATUS,0,6);
  if(d.byteLength<6) throw new Error(`GETSTATUS: short ${d.byteLength}B`);
  const status=d.getUint8(0);
  const pollMs=d.getUint8(1)|(d.getUint8(2)<<8)|(d.getUint8(3)<<16);
  const state=d.getUint8(4);
  return{status, statusName:STNAME[status]||hex(status,2),
         pollMs, state, stateName:SNAME[state]||`??(${state})`};
}

async function clrstatus(){ await rawOut(DFU_CLRSTATUS,0,new ArrayBuffer(0)) }
async function doAbort()  { await rawOut(DFU_ABORT,0,new ArrayBuffer(0)) }

// Send a DNLOAD and return the transfer status ('ok' or 'stall').
// Does NOT throw on stall — caller decides how to handle it.
async function dnload(blkNum, ab){
  const status = await rawOut(DFU_DNLOAD, blkNum, ab);
  if(status==='stall'){
    log(`  DNLOAD stall (blk=${blkNum} len=${ab.byteLength}) — reading device error…`,'log-warn');
  }
  return status;
}

// Poll until out of dfuDNLOAD-SYNC / dfuDNBUSY. Returns the final status struct.
// Only logs when the device actually needed multiple polls — avoids per-chunk DOM writes.
async function pollUntilIdle(tag){
  let st=await getstatus();
  let polls=0;
  while((st.state===S.dfuDNLOAD_SYNC||st.state===S.dfuDNBUSY)&&++polls<600){
    await sleep(st.pollMs||2);
    st=await getstatus();
  }
  if(polls>=600) throw new Error(`poll watchdog [${tag}]`);
  if(polls>1) log(`    [${tag}] settled after ${polls} polls — ${st.stateName}`,'log-info');
  return st;
}

// Bring device to dfuIDLE regardless of starting state.
// Also handles unknown/corrupt states (e.g. after an oversized chunk overwrote
// the device's internal DFU state machine) by always trying clrstatus first.
async function toIdle(){
  let st=await getstatus();
  log(`toIdle: current=${st.stateName}`,'log-info');
  if(st.state===S.dfuIDLE)return;
  // clrstatus is only spec-valid from dfuERROR, but also helps devices stuck in
  // an unknown state (SNAME[x] === undefined for any x outside 0-10).
  if(st.state===S.dfuERROR||!SNAME[st.state]){
    try{await clrstatus()}catch(e){}
    await sleep(10);
    st=await getstatus();
    if(st.state===S.dfuIDLE){log('toIdle ✓','log-ok');return;}
  }
  await doAbort();await sleep(5);
  st=await getstatus();
  if(st.state===S.dfuERROR||!SNAME[st.state]){
    try{await clrstatus()}catch(e){}
    await sleep(10);
    st=await getstatus();
  }
  if(st.state!==S.dfuIDLE) throw new Error(`Cannot reach dfuIDLE: ${st.stateName}`);
  log(`toIdle ✓`,'log-ok');
}

// ── DfuSe special command (wBlockNum=0) ───────────────────────────────────
// Send command, poll until done (leaves device in dfuDNLOAD-IDLE).
async function specialCmd(name, payloadU8){
  const ab=mkbuf(payloadU8);
  const txStatus=await dnload(0, ab);
  if(txStatus==='stall'){
    const st=await getstatus().catch(()=>null);
    throw new Error(`${name} DNLOAD stalled: device=${st?`${st.statusName}/${st.stateName}`:'unknown'}`);
  }
  const st=await pollUntilIdle(name);
  if(st.state===S.dfuERROR)
    throw new Error(`${name} failed: ${st.statusName}`);
  // device is now in dfuDNLOAD-IDLE
}

async function setAddress(addr){
  log(`DfuSe SetAddress ${hex(addr)}`,'log-info');
  await specialCmd('SetAddress', new Uint8Array([
    0x21, addr&0xFF, (addr>>8)&0xFF, (addr>>16)&0xFF, (addr>>24)&0xFF
  ]));
}

async function erasePage(addr){
  await specialCmd('ErasePage', new Uint8Array([
    0x41, addr&0xFF, (addr>>8)&0xFF, (addr>>16)&0xFF, (addr>>24)&0xFF
  ]));
}

async function massErase(){
  log(`DfuSe Mass Erase…`,'log-warn');
  const txStatus=await dnload(0, mkbuf(new Uint8Array([0x41])));
  if(txStatus==='stall') throw new Error('Mass erase DNLOAD stalled');
  let st=await getstatus();
  log(`  MassErase: ${st.stateName} poll=${st.pollMs}ms`,'log-warn');
  // STM32F4 lies — reports 100ms but actually needs up to 32s
  const timeout = st.pollMs===100 ? 35000 : (st.pollMs||500);
  let guard=120;
  while((st.state===S.dfuDNLOAD_SYNC||st.state===S.dfuDNBUSY)&&--guard>0){
    await sleep(timeout);
    st=await getstatus();
    log(`  MassErase: ${st.stateName}`,'log-warn');
  }
  if(st.state===S.dfuERROR) throw new Error(`Mass erase failed: ${st.statusName}`);
  if(guard<=0) throw new Error('Mass erase watchdog');
  log(`Mass Erase done ✓`,'log-ok');
  // device in dfuDNLOAD-IDLE — caller must abort to dfuIDLE
}

// ── Shared flash-sequence stages ──────────────────────────────────────────
// doFlash and doFlashAndVerifyDFU run the same erase, write, and leave stages;
// these helpers hold the single copy. They emit the exact same control-transfer
// sequence the inline code used — only stage boundaries moved into functions.

// Reset to dfuIDLE, mass-erase, recover to dfuIDLE.
async function dfuEraseFlash(){
  setSt('Preparing','Resetting…','busy');
  await toIdle();
  setSt('Erasing','Mass erase…','busy');
  setProgress('Erasing',0);
  await massErase();
  await doAbort();await sleep(5);
  const st=await getstatus();
  log(`Post-mass-erase: ${st.stateName}`,'log-info');
  if(st.state===S.dfuERROR){await clrstatus();await sleep(10);}
  await toIdle();
}

// Set base address once, then write all chunks via wBlockNum=2+i (AN3156 §5.1:
// the bootloader computes addr = startAddress + (wBlockNum−2)×wTransferSize).
async function dfuWriteFirmware(fw,addr){
  const nChunks=Math.ceil(fw.byteLength/xferSize);
  setSt('Writing','Starting…','busy');
  log(`Writing ${nChunks} chunks…`,'log-info');
  setProgress('Writing',0);
  await setAddress(addr);
  for(let i=0;i<nChunks;i++){
    const off=i*xferSize;
    const len=Math.min(xferSize,fw.byteLength-off);
    const ab=mkbuf(fw.subarray(off,off+len));
    const txStatus=await dnload(2+i,ab);
    if(txStatus==='stall'){
      const errSt=await getstatus().catch(()=>null);
      throw new Error(`Write stall [chunk${i}]: ${errSt?.statusName??'unknown'}`);
    }
    const st=await pollUntilIdle(`chunk${i}`);
    if(st.state!==S.dfuDNLOAD_IDLE)
      throw new Error(`Write failed [chunk${i}]: state=${st.stateName} status=${st.statusName}`);
    const pct=(i+1)/nChunks*100;
    setProgress(`Writing ${i+1}/${nChunks}`,pct);
    setSt('Writing',`${i+1}/${nChunks} @ ${hex(addr+off)} (${pct.toFixed(0)}%)`,'busy');
    if(i===0||i%10===9||i===nChunks-1)
      log(`  ✓ chunk ${i+1}/${nChunks}  ${hex(addr+off)}  ${pct.toFixed(0)}%`,'log-ok');
  }
  log(`All ${nChunks} chunks written ✓`,'log-ok');
}

// Leave DFU (SetAddress → zero-length DNLOAD = DfuSe jump trigger), then release
// and close the device. `reIdle` runs toIdle() first (verify path leaves the
// device in dfuIDLE; the plain flash path leaves it in dfuDNLOAD-IDLE, where
// SetAddress is already valid, so it must NOT re-idle).
async function dfuLeaveAndClose(addr,reIdle){
  setSt('Leaving DFU','Jumping to app…','busy');
  log(`Leave: SetAddress(${hex(addr)}) → DNLOAD(0,0) → device reset`,'log-info');
  leavingDFU=true;
  try{
    if(reIdle) await toIdle();
    await setAddress(addr);               // re-set address_pointer to app start
    await dnload(0, new ArrayBuffer(0));  // wBlockNum=0, wLength=0 = DfuSe jump trigger
    await sleep(5);
    await getstatus().catch(()=>{});      // device resets here — disconnect expected
  }catch(e){
    if(usbDev) log(`Leave error: ${e.message}`,'log-warn');
  }
  leavingDFU=false;
  await sleep(400);
  if(usbDev){
    try{await usbDev.releaseInterface(dfuIface.interfaceNumber)}catch(e){}
    try{await usbDev.close()}catch(e){}
  }
  usbDev=null;dfuIface=null;
  setDevUI(false,'Device reset — jumped to app','—');
  log('Jumped to application ✓','log-ok');
}

// Flash without leaving DFU, then verify, then leave.
// Returns true on success, false on failure (verify mismatch, error, or a
// mid-flash DFU disconnect — rawIn/rawOut throw once usbDev is nulled) so the
// wizard can stop and surface an error instead of marking the step done.
async function doFlashAndVerifyDFU(){
  if(!usbDev||!fwBuf)return false;
  const addr=FLASH_BASE_ADDR;

  $('btnFlash').disabled=true;
  $('btnFlashVerifyDFU').disabled=true;
  $('btnConnect').disabled=true;

  try{
    const fw=new Uint8Array(fwBuf);
    const nChunks=Math.ceil(fw.byteLength/xferSize);
    log('──── Flash+Verify Start ────','log-info');
    log(`addr=${hex(addr)}  size=${fw.byteLength}B  xfer=${xferSize}B`,'log-info');

    await dfuEraseFlash();
    await dfuWriteFirmware(fw,addr);

    // ── Verify ──────────────────────────────────────────────────────────────
    // Abort from dfuDNLOAD-IDLE back to dfuIDLE, then set address and upload.
    await doAbort();await sleep(5);
    const stAfterWrite=await getstatus();
    if(stAfterWrite.state===S.dfuERROR){await clrstatus();await sleep(10);}
    await toIdle();
    await setAddress(addr);
    await doAbort();await sleep(5);
    const stAfterSetAddr=await getstatus();
    if(stAfterSetAddr.state===S.dfuERROR){await clrstatus();await sleep(10);}
    await toIdle();

    setSt('Verifying','Reading back…','busy');
    setProgress('Verifying',0);
    let mismatch=0;
    for(let i=0;i<nChunks;i++){
      const off=i*xferSize;
      const len=Math.min(xferSize,fw.byteLength-off);
      const dv=await rawIn(DFU_UPLOAD, 2+i, len);
      if(dv.byteLength!==len) throw new Error(`Read short: chunk${i} expected ${len}B got ${dv.byteLength}B`);
      const read=new Uint8Array(dv.buffer,dv.byteOffset,dv.byteLength);
      for(let b=0;b<len;b++){
        if(read[b]!==fw[off+b]){mismatch++;break;}
      }
      const pct=(i+1)/nChunks*100;
      setProgress(`Verifying ${i+1}/${nChunks}`,pct);
      setSt('Verifying',`${i+1}/${nChunks} @ ${hex(addr+off)} (${pct.toFixed(0)}%)`,'busy');
      if(i%10===9||i===nChunks-1) await sleep(1); // yield to browser for repaint every 10 chunks
      if(i===0||i%10===9||i===nChunks-1)
        log(`  ✓ read chunk ${i+1}/${nChunks}  ${hex(addr+off)}  ${pct.toFixed(0)}%`,'log-ok');
    }
    try{await doAbort();await sleep(5);}catch(e){}

    if(mismatch>0){
      log(`Verify FAILED: ${mismatch} chunk(s) mismatched`,'log-err');
      setSt('Verify Failed',`${mismatch} chunk(s) mismatched`,'err');
      $('devIndicator').className='device-indicator error';
      return false;
    }
    log(`Verify ✓ — all chunks match`,'log-ok');

    await dfuLeaveAndClose(addr,true);

    setProgress('Complete',100);
    setSt('Done',`${(fw.byteLength/1024).toFixed(1)} KiB flashed and verified`,'ok');
    log('──── Flash+Verify Complete ✓ ────','log-ok');
    return true;

  }catch(e){
    log(`Fatal: ${e.message}`,'log-err');
    console.error(e);
    try{const st=await getstatus();log(`Device state at error: ${st.stateName}/${st.statusName}`,'log-err');}catch(e2){}
    setSt('Error',e.message,'err');
    $('devIndicator').className='device-indicator error';
    return false;
  }finally{
    const ready=!!(usbDev&&fwBuf);
    $('btnFlash').disabled=!ready;
    $('btnFlashVerifyDFU').disabled=!ready;
    $('btnConnect').disabled=false;
  }
}

// ── Main flash routine ────────────────────────────────────────────────────
// Returns true on success, false on failure (incl. a mid-flash DFU disconnect,
// which makes rawIn/rawOut throw) so the wizard can stop and surface an error.
async function doFlash(){
  if(!usbDev||!fwBuf)return false;
  const addr=FLASH_BASE_ADDR;

  $('btnFlash').disabled=true;
  $('btnConnect').disabled=true;

  try{
    const fw=new Uint8Array(fwBuf);
    log('──── Flash Start ────','log-info');
    log(`addr=${hex(addr)}  size=${fw.byteLength}B  xfer=${xferSize}B  page=${pageSize}B`,'log-info');

    await dfuEraseFlash();
    await dfuWriteFirmware(fw,addr);
    await dfuLeaveAndClose(addr,false);

    setProgress('Complete',100);
    setSt('Done',`${(fw.byteLength/1024).toFixed(1)} KiB flashed`,'ok');
    log('──── Flash Complete ✓ ────','log-ok');
    return true;

  }catch(e){
    log(`Fatal: ${e.message}`,'log-err');
    console.error(e);
    try{
      const st=await getstatus();
      log(`Device state at error: ${st.stateName} / ${st.statusName}`,'log-err');
    }catch(e2){}
    setSt('Error',e.message,'err');
    $('devIndicator').className='device-indicator error';
    return false;
  }finally{
    $('btnFlash').disabled=!(usbDev&&fwBuf);
    $('btnConnect').disabled=false;
  }
}
