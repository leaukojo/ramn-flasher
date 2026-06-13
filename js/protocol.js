// ── Pure protocol helpers ─────────────────────────────────────────────────
// Side-effect-free functions (no DOM, no navigator) shared across the app and
// unit-tested by js/protocol.test.js. Loaded first so every later file can use
// them as globals. The module.exports guard at the bottom makes the same plain
// globals require-able under `node --test` without any build step.

// Search an extras blob (ArrayBuffer, DataView, or Uint8Array) for a DFU
// functional descriptor (bDescriptorType=0x21) and return its fields.
function parseExtras(extras){
  try{
    if(!extras||extras.byteLength<9)return null;
    // extras may be ArrayBuffer, DataView, or Uint8Array depending on Chrome version.
    const ab=extras.buffer||extras;
    const base=extras.byteOffset||0;
    const buf=new Uint8Array(ab,base,extras.byteLength);
    for(let i=0;i+8<buf.byteLength;i++){
      if(buf[i+1]===0x21&&buf[i]>=9){
        const v=new DataView(ab,base+i,buf[i]);
        return{bmAttr:v.getUint8(2),wDetach:v.getUint16(3,true),
               wTransferSize:v.getUint16(5,true),bcdDFU:v.getUint16(7,true)};
      }
    }
  }catch(e){}
  return null;
}

function parsePageSize(altName, targetAddr){
  try{
    const m=altName.match(/\/0x([0-9a-fA-F]+)\/(.+)/);
    if(!m)return null;
    let addr=parseInt(m[1],16);
    for(const seg of m[2].split(',')){
      const sm=seg.trim().match(/(\d+)\*(\d+)(.)(.)/i);
      if(!sm)continue;
      const count=parseInt(sm[1]);
      let size=parseInt(sm[2]);
      const unit=sm[3].toUpperCase();
      if(unit==='K')size*=1024;
      else if(unit==='M')size*=1024*1024;
      const end=addr+count*size;
      if(targetAddr>=addr&&targetAddr<end)return size;
      addr=end;
    }
  }catch(e){}
  return null;
}

function parseIntelHex(text){
  // Two-pass: first find the address range, then fill a compact buffer.
  const lines=text.trim().split(/\r?\n/);
  const b=(s,i)=>parseInt(s.slice(i,i+2),16);
  let base=0,minAddr=Infinity,maxAddr=0;
  for(const line of lines){
    if(line[0]!==':') continue;
    const len=b(line,1),addr=(b(line,3)<<8)|b(line,5),type=b(line,7);
    if(type===0x01) break;
    if(type===0x04){base=((b(line,9)<<8)|b(line,11))<<16; continue;}
    if(type===0x02){base=((b(line,9)<<8)|b(line,11))<<4; continue;}
    if(type!==0x00||len===0) continue;
    const abs=base+addr;
    minAddr=Math.min(minAddr,abs);
    maxAddr=Math.max(maxAddr,abs+len);
  }
  if(maxAddr<=minAddr) throw new Error('No data records in hex file');
  const buf=new Uint8Array(maxAddr-minAddr);
  base=0;
  for(const line of lines){
    if(line[0]!==':') continue;
    const len=b(line,1),addr=(b(line,3)<<8)|b(line,5),type=b(line,7);
    if(type===0x01) break;
    if(type===0x04){base=((b(line,9)<<8)|b(line,11))<<16; continue;}
    if(type===0x02){base=((b(line,9)<<8)|b(line,11))<<4; continue;}
    if(type!==0x00||len===0) continue;
    const abs=base+addr-minAddr;
    for(let i=0;i<len;i++) buf[abs+i]=b(line,9+i*2);
  }
  return buf.buffer;
}

// ── CAN-FD bootloader frame helpers (AN5405) ──────────────────────────────
function getFDCANDLC(len){
  if(len<=8)return len;if(len<=12)return 9;if(len<=16)return 0xA;
  if(len<=20)return 0xB;if(len<=24)return 0xC;if(len<=32)return 0xD;
  if(len<=48)return 0xE;return 0xF;
}
function getFDCANPadding(len){
  if(len<=8)return '';
  const slots=[12,16,20,24,32,48,64];
  for(const s of slots)if(len<=s)return '00'.repeat(s-len);
  return '';
}
function canIsACK(line,cmd){return line==='1t'+cmd.toString(16).padStart(3,'0')+'179'}
function canIsNACK(line,cmd){return line==='1t'+cmd.toString(16).padStart(3,'0')+'11f'}

if(typeof module!=='undefined') module.exports={parseIntelHex,getFDCANDLC,getFDCANPadding,canIsACK,canIsNACK,parsePageSize,parseExtras};
