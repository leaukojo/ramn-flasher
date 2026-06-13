// ── Android WebUSB CDC-ACM fallback ──────────────────────────────────────
// Web Serial on Android Chrome cannot enumerate composite USB devices via the
// native serial path. We detect Android and use WebUSB bulk transfers instead,
// which work because the device is already USER-accessible via the USB Host API.
const _onAndroid=/Android/i.test(navigator.userAgent);
const SERIAL_USB_FILTERS=[{vendorId:0x0483,productId:0x5740},{vendorId:0x1d50,productId:0x606f}];

async function openWebUSBCDC(){
  const dev=await navigator.usb.requestDevice({filters:SERIAL_USB_FILTERS});
  await dev.open();
  if(dev.configuration===null)await dev.selectConfiguration(1);
  let ctrl=null,data=null,inEp=null,outEp=null;
  for(const ifc of dev.configuration.interfaces){
    const alt=ifc.alternates[0];
    if(alt.interfaceClass===0x02&&alt.interfaceSubclass===0x02)ctrl=ifc.interfaceNumber;
    if(alt.interfaceClass===0x0A){
      data=ifc.interfaceNumber;
      for(const ep of alt.endpoints){
        if(ep.direction==='in')inEp=ep.endpointNumber;
        if(ep.direction==='out')outEp=ep.endpointNumber;
      }
    }
  }
  if(data===null)throw new Error('CDC-ACM data interface not found');
  if(ctrl!==null)await dev.claimInterface(ctrl);
  await dev.claimInterface(data);
  if(ctrl!==null){
    const coding=new ArrayBuffer(7);const v=new DataView(coding);
    v.setUint32(0,115200,true);v.setUint8(4,0);v.setUint8(5,0);v.setUint8(6,8);
    await dev.controlTransferOut({requestType:'class',recipient:'interface',request:0x20,value:0,index:ctrl},coding);
    await dev.controlTransferOut({requestType:'class',recipient:'interface',request:0x22,value:0x03,index:ctrl});
  }
  return{dev,data,inEp,outEp};
}

async function usbSerialPump(){
  try{
    while(usbSerDev){
      const r=await usbSerDev.transferIn(usbSerIn,64);
      if(r.data&&r.data.byteLength>0)serialBuf+=new TextDecoder().decode(r.data);
    }
  }catch(e){}
}

// ── Web Serial — DFU trigger ──────────────────────────────────────────────
async function doTriggerDFU(){
  if(!navigator.serial){log('Web Serial not supported — use Chrome/Edge','log-err');return}
  $('btnTriggerDFU').disabled=true;
  $('btnConnectSer').disabled=true;
  $('btnTriggerDFU').classList.remove('btn-hint');
  $('connectFailMsg').style.display='none';
  const banner=$('triggerBanner');
  banner.style.display='';banner.style.color='var(--muted)';banner.textContent='Opening serial port…';
  try{
    if(_onAndroid&&navigator.usb){
      const{dev,outEp}=await openWebUSBCDC();
      await dev.transferOut(outEp,new TextEncoder().encode('DzZ\r'));
      await sleep(200);
      await dev.close();
    }else{
      const port=await navigator.serial.requestPort({filters:[{usbVendorId:0x0483,usbProductId:0x5740},{usbVendorId:0x1d50,usbProductId:0x606f}]});
      await port.open({baudRate:115200});
      const w=port.writable.getWriter();
      await w.write(new TextEncoder().encode('DzZ\r'));
      await sleep(200);
      w.releaseLock();
      await port.close();
    }
    banner.style.color='var(--accent2)';
    banner.textContent='Device rebooting into DFU — now click Connect ↑';
    log('DFU trigger sent — device rebooting…','log-ok');
    $('btnConnect').classList.add('btn-hint');
  }catch(e){
    banner.style.display='';
    banner.style.color='var(--warning)';
    if(e.name==='NotFoundError'){
      banner.textContent='No device selected — make sure RAMN is plugged in and not in use by another application.';
    }else{
      banner.textContent='Could not open device — check RAMN is plugged in.';
      log(`Trigger failed: ${e.message}`,'log-err');
    }
  }finally{$('btnTriggerDFU').disabled=!!usbDev||serConnected;$('btnConnectSer').disabled=false;}
}

// ── Web Serial — CAN session ──────────────────────────────────────────────
async function serialPump(){
  try{
    while(serialReader){
      const{value,done}=await serialReader.read();
      if(done)break;
      if(value)serialBuf+=new TextDecoder().decode(value);
    }
  }catch(e){}
}

async function serialReadLine(timeoutMs=5000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    // Abort immediately if the device was unplugged mid-flash. Throw (rather than
    // return null, which the caller reads as a benign timeout) so the disconnect
    // surfaces as a clear error and unwinds the whole flash sequence at once.
    if(!serConnected) throw new Error('Serial port disconnected during flash');
    const cr=serialBuf.indexOf('\r');
    if(cr!==-1){
      const line=serialBuf.slice(0,cr);
      serialBuf=serialBuf.slice(cr+1);
      if(line.startsWith('d')){log('CAN error frame: '+line,'log-warn');continue;}
      // BEL (0x07) = ECU A rejected the slcan command; fall through and return the line
      // so the caller can time out naturally rather than spinning silently.
      if(line.startsWith('\x07'))log('ECU A rejected slcan command','log-err');
      return line;
    }
    await sleep(10);
  }
  return null;
}

async function serialWrite(str){
  // Guard first so a mid-flash unplug fails with a clear message rather than a
  // lower-level transferOut/write error (or a silent no-op once serWriter is nulled).
  if(!serConnected)throw new Error('Serial port disconnected during flash');
  const enc=new TextEncoder().encode(str);
  if(usbSerDev){await usbSerDev.transferOut(usbSerOut,enc);return;}
  if(!serWriter)throw new Error('Serial not connected');
  await serWriter.write(enc);
}

async function doConnectSerial(){
  if(!navigator.serial&&!(_onAndroid&&navigator.usb)){log('Web Serial not supported','log-err');return}
  $('serConnectWarnMsg').style.display='none';
  try{
    if(_onAndroid&&navigator.usb){
      const{dev,data,inEp,outEp}=await openWebUSBCDC();
      usbSerDev=dev;usbSerIfc=data;usbSerIn=inEp;usbSerOut=outEp;
      serialBuf='';serConnected=true;
      setSerUI(true,'Serial port open (WebUSB)','');
      log('Serial port opened via WebUSB ✓','log-ok');
      usbSerialPump();
    }else{
      serPort=await navigator.serial.requestPort({filters:[{usbVendorId:0x0483,usbProductId:0x5740},{usbVendorId:0x1d50,usbProductId:0x606f}]});
      await serPort.open({baudRate:115200});
      serialReader=serPort.readable.getReader();
      serWriter=serPort.writable.getWriter();
      serialBuf='';serConnected=true;
      setSerUI(true,'Serial port open','');
      log('Serial port opened ✓','log-ok');
      serialPump(); // background reader — fire-and-forget
    }
  }catch(e){
    if(e.name==='NotFoundError'){
      $('serConnectWarnMsg').style.display='';
    }else{
      log(`Serial connect failed: ${e.message}`,'log-err');
    }
    serPort=null;usbSerDev=null;serConnected=false;
    setSerUI(false,'No serial port open','—');
  }
  updateCanFlashBtn();
}

async function doDisconnectSerial(){
  if(usbSerDev){
    const dev=usbSerDev;
    usbSerDev=null;usbSerIfc=null;usbSerIn=null;usbSerOut=null; // clear first so pump exits
    try{await dev.close()}catch(e){}
  }else{
    try{if(serialReader)await serialReader.cancel()}catch(e){}
    try{if(serialReader)serialReader.releaseLock()}catch(e){}
    try{if(serWriter)serWriter.releaseLock()}catch(e){}
    try{if(serPort)await serPort.close()}catch(e){}
    serPort=null;serialReader=null;serWriter=null;
  }
  serialBuf='';serConnected=false;
  setSerUI(false,'No serial port open','—');
  log('Serial disconnected','log-warn');
  updateCanFlashBtn();
}

// ── CAN-FD bootloader protocol (AN5405) ───────────────────────────────────
// Frame helpers (getFDCANDLC, getFDCANPadding, canIsACK, canIsNACK) live in protocol.js.

async function canSendFrame(cmd,paramsHex=''){
  const n=paramsHex.length/2;
  const frame='1t'+cmd.toString(16).padStart(3,'0')+getFDCANDLC(n).toString(16)+paramsHex+getFDCANPadding(n)+'\r';
  await serialWrite(frame);
}

async function canWaitForACK(cmd,timeoutMs=5000){
  // Absolute deadline so a noisy CAN bus (stray frames from other ECUs) can't
  // keep resetting the per-read timeout and spin forever.
  const deadline=Date.now()+timeoutMs;
  while(true){
    const remaining=deadline-Date.now();
    if(remaining<=0){log(`CAN timeout (cmd=${hex(cmd,2)})`,'log-err');return false;}
    const line=await serialReadLine(remaining);
    if(line===null){log(`CAN timeout (cmd=${hex(cmd,2)})`,'log-err');return false;}
    if(canIsACK(line,cmd))return true;
    if(canIsNACK(line,cmd)){log('CAN NACK from target','log-err');return false;}
    // other lines: keep waiting (bus noise, etc.)
  }
}

async function canStartBootloader(letter){
  log(`Entering bootloader on ECU ${letter}…`,'log-info');
  await serialWrite('p'+letter+'\r');
  const line=await serialReadLine(5000);
  if(line===null){log(`ECU ${letter} bootloader timeout`,'log-err');return false;}
  log(`ECU ${letter} bootloader entered ✓`,'log-ok');
  return true;
}

async function canEraseMemory(){
  log('Erasing flash…','log-warn');
  await canSendFrame(CMD_ERASE,'FFFF');
  if(!await canWaitForACK(CMD_ERASE,10000))return false; // erase accepted
  if(!await canWaitForACK(CMD_ERASE,30000))return false; // erase complete
  log('Flash erased ✓','log-ok');
  return true;
}

async function canWriteChunk(addr,chunk){
  // chunk is Uint8Array, length 1–CAN_CHUNK_SIZE
  const header=(addr>>>0).toString(16).padStart(8,'0')+(chunk.length-1).toString(16).padStart(2,'0');
  await canSendFrame(CMD_WRITEMEM,header);
  if(!await canWaitForACK(CMD_WRITEMEM,5000))return false;
  // Send data in sub-frames (no ACK wait between them)
  for(let i=0;i<chunk.length;i+=CAN_SUBFRAME_SIZE){
    const sub=chunk.subarray(i,Math.min(i+CAN_SUBFRAME_SIZE,chunk.length));
    let hexStr='';for(const b of sub)hexStr+=b.toString(16).padStart(2,'0');
    await canSendFrame(CMD_WRITEMEM,hexStr);
  }
  if(!await canWaitForACK(CMD_WRITEMEM,5000))return false;
  return true;
}

async function canFlashFirmware(buf){
  const fw=new Uint8Array(buf);
  const n=Math.ceil(fw.byteLength/CAN_CHUNK_SIZE);
  for(let i=0;i<n;i++){
    const addr=CAN_FLASH_ADDR+i*CAN_CHUNK_SIZE;
    const chunk=fw.subarray(i*CAN_CHUNK_SIZE,Math.min((i+1)*CAN_CHUNK_SIZE,fw.byteLength));
    if(!await canWriteChunk(addr,chunk)){
      log(`Write failed at chunk ${i+1}/${n}  ${hex(addr)}`,'log-err');return false;
    }
    const pct=(i+1)/n*100;
    setProgress(`Writing ${i+1}/${n}`,pct);
    if(i===0||i%20===19||i===n-1)
      log(`  ✓ chunk ${i+1}/${n}  ${hex(addr)}  ${pct.toFixed(0)}%`,'log-ok');
  }
  return true;
}

async function canGoToApp(){
  await canSendFrame(CMD_GO,CAN_FLASH_ADDR.toString(16).padStart(8,'0'));
  if(!await canWaitForACK(CMD_GO,3000)){log('GO command refused','log-err');return false;}
  log('ECU jumped to application ✓','log-ok');
  return true;
}

async function doFlashCAN(letter,buf){
  log(`──── Flash ECU ${letter} (CAN-FD) ────`,'log-info');
  setSt(`Flashing ECU ${letter}`,'Entering bootloader…','busy');
  if(!await canStartBootloader(letter))throw new Error(`ECU ${letter} bootloader entry failed`);
  setSt(`Flashing ECU ${letter}`,'Erasing…','busy');
  setProgress('Erasing',0);
  if(!await canEraseMemory())throw new Error(`ECU ${letter} erase failed`);
  setSt(`Flashing ECU ${letter}`,'Writing…','busy');
  if(!await canFlashFirmware(buf))throw new Error(`ECU ${letter} write failed`);
  setSt(`Flashing ECU ${letter}`,'Jumping to app…','busy');
  if(!await canGoToApp())throw new Error(`ECU ${letter} GO failed`);
  await sleep(1000);
  log(`──── ECU ${letter} done ✓ ────`,'log-ok');
}

async function canResetRAMN(){
  log('Resetting RAMN…','log-warn');
  try{await serialWrite('n\r');}catch(e){}
  await sleep(300);
  await doDisconnectSerial();
  log('RAMN reset sent ✓','log-ok');
}

function getEcuBBuf(){
  return (!$('chkBLog').checked && fwBufBLinear) ? fwBufBLinear : fwBufB;
}

// Shared driver for the three "all ECU B/C/D" operations. `perEcuFn(letter,buf)`
// runs per selected+loaded ECU; `doneDetail`/`doneLog` are the success messages.
// Returns true on success, false if any ECU failed (incl. mid-flash disconnect)
// so callers (the wizard) can stop and surface an error instead of continuing.
async function runAllCAN(perEcuFn,doneDetail,doneLog){
  if(!serConnected){log('Serial not connected','log-err');return false;}
  $('btnFlashCAN').disabled=$('btnVerifyCAN').disabled=$('btnFlashVerifyCAN').disabled=true;
  try{
    const ecus=[{l:'B',buf:getEcuBBuf(),chk:$('chkB')},{l:'C',buf:fwBufC,chk:$('chkC')},{l:'D',buf:fwBufD,chk:$('chkD')}];
    for(const{l,buf,chk}of ecus){
      if(!chk.checked)continue;
      if(!buf){log(`No firmware for ECU ${l} — skipping`,'log-warn');continue;}
      await perEcuFn(l,buf);
    }
    setProgress('Complete',100);
    setSt('Done',doneDetail,'ok');
    log(doneLog,'log-ok');
    if($('chkReset').checked)await canResetRAMN();
    return true;
  }catch(e){
    log(`Fatal: ${e.message}`,'log-err');setSt('Error',e.message,'err');
    return false;
  }finally{
    updateCanFlashBtn();
  }
}

async function doFlashAllCAN(){
  return runAllCAN(doFlashCAN,'ECU B/C/D flash complete','──── CAN Flash Complete ✓ ────');
}

async function canReadMemory(addr,size){
  // size: 1–CAN_CHUNK_SIZE. Returns hex string of `size` bytes, or null on error.
  const header=(addr>>>0).toString(16).padStart(8,'0')+(size-1).toString(16).padStart(2,'0');
  await canSendFrame(CMD_READMEM,header);
  if(!await canWaitForACK(CMD_READMEM,5000))return null;
  // Collect data frames until final ACK. Filter to the READMEM response prefix
  // "1t{cmd3}" so stray frames from other ECUs on the bus aren't appended as
  // flash data; use an absolute deadline so noise can't spin the loop forever.
  const respPrefix='1t'+CMD_READMEM.toString(16).padStart(3,'0');
  const deadline=Date.now()+5000;
  let hexData='';
  while(true){
    const remaining=deadline-Date.now();
    if(remaining<=0){log('Read memory timeout','log-err');return null;}
    const line=await serialReadLine(remaining);
    if(line===null){log('Read memory timeout','log-err');return null;}
    if(canIsACK(line,CMD_READMEM))break;
    if(canIsNACK(line,CMD_READMEM)){log('Read memory NACK','log-err');return null;}
    if(!line.startsWith(respPrefix))continue; // ignore unrelated bus frames
    hexData+=line.slice(6); // skip "1t{cmd3}{dlc1}" prefix
  }
  return hexData.slice(0,size*2); // trim CAN-FD padding
}

async function canVerifyFirmware(buf){
  const fw=new Uint8Array(buf);
  const n=Math.ceil(fw.byteLength/CAN_CHUNK_SIZE);
  for(let i=0;i<n;i++){
    const addr=CAN_FLASH_ADDR+i*CAN_CHUNK_SIZE;
    const size=Math.min(CAN_CHUNK_SIZE,fw.byteLength-i*CAN_CHUNK_SIZE);
    const hexData=await canReadMemory(addr,size);
    if(hexData===null){log(`Read failed at ${hex(addr)}`,'log-err');return false;}
    for(let j=0;j<size;j++){
      const expected=fw[i*CAN_CHUNK_SIZE+j];
      const got=parseInt(hexData.slice(j*2,j*2+2),16);
      if(expected!==got){
        log(`Mismatch at ${hex(addr+j)}: expected ${hex(expected,2)} got ${hex(got,2)}`,'log-err');
        return false;
      }
    }
    const pct=(i+1)/n*100;
    setProgress(`Verifying ${i+1}/${n}`,pct);
    await sleep(1); // yield to browser so progress bar repaints between chunks
    if(i===0||i%20===19||i===n-1)
      log(`  ✓ chunk ${i+1}/${n}  ${hex(addr)}  ${pct.toFixed(0)}%`,'log-ok');
  }
  return true;
}

async function doVerifyCAN(letter,buf){
  log(`──── Verify ECU ${letter} (CAN-FD) ────`,'log-info');
  setSt(`Verifying ECU ${letter}`,'Entering bootloader…','busy');
  if(!await canStartBootloader(letter))throw new Error(`ECU ${letter} bootloader entry failed`);
  setSt(`Verifying ECU ${letter}`,'Reading flash…','busy');
  setProgress('Verifying',0);
  if(!await canVerifyFirmware(buf))throw new Error(`ECU ${letter} verify failed`);
  setSt(`Verifying ECU ${letter}`,'Jumping to app…','busy');
  if(!await canGoToApp())throw new Error(`ECU ${letter} GO failed`);
  await sleep(1000);
  log(`──── ECU ${letter} verified ✓ ────`,'log-ok');
}

async function doVerifyAllCAN(){
  return runAllCAN(doVerifyCAN,'ECU B/C/D verify complete','──── CAN Verify Complete ✓ ────');
}

async function doFlashAndVerifyCAN(letter,buf){
  // Flash then verify run the same two passes back-to-back: each does its own
  // bootloader entry, GO, and 1s settle, so this is exactly the two in sequence.
  await doFlashCAN(letter,buf);
  await doVerifyCAN(letter,buf);
}

async function doFlashAndVerifyAllCAN(){
  return runAllCAN(doFlashAndVerifyCAN,'ECU B/C/D flash & verify complete','──── CAN Flash & Verify Complete ✓ ────');
}
