// ── Event listeners ───────────────────────────────────────────────────────
// Wrap a flash/verify op so the firmware card is greyed out for its duration,
// and always restored even if the op throws.
const withBusy=fn=>async()=>{setFwCardBusy(true);try{await fn();}finally{setFwCardBusy(false);}};
$('btnConnect').addEventListener('click',async()=>{usbDev?await doDisconnect():await doConnect()});
$('btnFlash').addEventListener('click',withBusy(doFlash));
$('btnFlashVerifyDFU').addEventListener('click',withBusy(doFlashAndVerifyDFU));
$('btnFlashCAN').addEventListener('click',withBusy(doFlashAllCAN));
$('btnVerifyCAN').addEventListener('click',withBusy(doVerifyAllCAN));
$('btnFlashVerifyCAN').addEventListener('click',withBusy(doFlashAndVerifyAllCAN));
$('chkB').addEventListener('change',onChkBChange);
['chkC','chkD'].forEach(id=>$(id).addEventListener('change',updateCanFlashBtn));
$('chkBLog').addEventListener('change',updateLinearMsg);

// Hint: highlight firmware card when hovering disabled flash buttons with no firmware loaded
['btnFlash','btnFlashVerifyDFU'].forEach(id=>{
  $(id).addEventListener('mouseenter',()=>{ if(!fwBuf) highlightFwCard(); });
});
['btnFlashCAN','btnVerifyCAN','btnFlashVerifyCAN'].forEach(id=>{
  $(id).addEventListener('mouseenter',()=>{ if(!fwBufB&&!fwBufC&&!fwBufD) highlightFwCard(); });
});

// ── Init ──────────────────────────────────────────────────────────────────
if(!navigator.usb){
  log('WebUSB not available — ECU A (DFU) cannot be flashed','log-err');
  $('btnConnect').disabled=true;$('btnTriggerDFU').disabled=true;
  $('btnConnect').title='WebUSB not available — use Chrome or Edge 89+';
  if(!navigator.serial){
    setSt('Unsupported','WebUSB and Web Serial require Chrome or Edge 89+ (or Chrome for Android with USB OTG)','err');
  }else{
    log('Web Serial available ✓','log-ok');
    setSt('Limited','ECU A (DFU) unavailable — ECU B/C/D ready','');
  }
}else{
  log('WebUSB available ✓','log-ok');
  if(!navigator.serial){
    log('Web Serial not available — ECU B/C/D and DFU trigger unavailable','log-warn');
    $('btnTriggerDFU').disabled=true;$('btnConnectSer').disabled=true;
    $('btnTriggerDFU').title=$('btnConnectSer').title='Web Serial not available — use Chrome or Edge 89+';
    setSt('Limited','ECU B/C/D unavailable — ECU A (DFU) ready','');
  }else{
    log('Web Serial available ✓','log-ok');
  }
  navigator.usb.addEventListener('disconnect',e=>{
    if(usbDev&&e.device===usbDev){
      usbDev=null;dfuIface=null;
      if(!leavingDFU){
        log('Device disconnected','log-warn');
        setDevUI(false,'Disconnected','—');
        setSt('Idle','Device disconnected');
      }
    }else if(usbSerDev&&e.device===usbSerDev){
      // Android WebUSB CDC-ACM serial path: tear down so an in-flight CAN
      // flash aborts (serialReadLine bails on !serConnected, serialWrite throws).
      usbSerDev=null;usbSerIfc=null;usbSerIn=null;usbSerOut=null;
      serConnected=false;
      log('Serial device disconnected','log-err');
      setSerUI(false,'No serial port open','—');
      updateCanFlashBtn();
    }
  });
}

// Web Serial disconnect — surface unplugs during a CAN flash instead of
// spinning until a read timeout. Nulling serWriter makes serialWrite throw and
// serConnected=false makes serialReadLine bail, so the flash aborts promptly.
if(navigator.serial){
  navigator.serial.addEventListener('disconnect',e=>{
    if(serConnected&&serPort&&e.target===serPort){
      serWriter=null;serialReader=null;serPort=null;
      serConnected=false;
      log('Serial device disconnected','log-err');
      setSerUI(false,'No serial port open','—');
      updateCanFlashBtn();
    }
  });
}
