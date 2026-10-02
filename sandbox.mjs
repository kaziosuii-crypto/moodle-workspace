/**
 * Source of the execution sandbox worker.
 *
 * wasi.start() runs the compiled module synchronously, so an infinite loop in
 * submitted code would block whatever thread it runs on. That must never be the
 * page's main thread, or the whole workspace freezes with no way to cancel.
 * Running inside a worker lets the host terminate it the moment a run overruns.
 *
 * The worker is created from a blob, so this file is only ever a string in the
 * bundle. It deliberately avoids template literals to keep that string simple.
 */
export const SANDBOX_SOURCE = String.raw`let shim=null,ready=false;
self.onmessage=async function(event){
  const msg=event.data||{};
  try{
    if(msg.type==='init'){
      // The two module URLs are blob URLs built from the compiler folder, so this
      // worker never touches the network either.
      // Import the two modules actually used instead of the index.js barrel:
      // the barrel also re-exports fs_opfs.js, and something in that graph calls
      // importScripts(), which a module worker refuses.
      const wasiModule=await import(msg.wasi);
      const fsModule=await import(msg.fs);
      shim={
        WASI:wasiModule.WASI||wasiModule.default,
        OpenFile:fsModule.OpenFile,
        File:fsModule.File,
        ConsoleStdout:fsModule.ConsoleStdout
      };
      ready=true;
      self.postMessage({id:msg.id,type:'ready'});
      return;
    }
    if(msg.type==='run'){
      if(!ready||!shim)throw new Error('执行沙箱尚未就绪');
      const decode=new TextDecoder();
      const out={text:''},err={text:''};
      const fds=[
        new shim.OpenFile(new shim.File(new TextEncoder().encode(msg.stdin||'')),'stdin'),
        new shim.ConsoleStdout(function(buffer){out.text+=typeof buffer==='string'?buffer:decode.decode(buffer);}),
        new shim.ConsoleStdout(function(buffer){err.text+=typeof buffer==='string'?buffer:decode.decode(buffer);})
      ];
      const wasi=new shim.WASI(['main'],{},fds,[]);
      try{
        const instance=await WebAssembly.instantiate(msg.module,{wasi_snapshot_preview1:wasi.wasiImport});
        wasi.start(instance.instance||instance);
      }catch(error){
        if(!/WASIProcExit/.test(String(error)))throw error;
      }
      self.postMessage({id:msg.id,type:'done',stdout:out.text,stderr:err.text});
      return;
    }
    throw new Error('未知的沙箱指令');
  }catch(error){
    self.postMessage({id:msg.id||0,type:'error',message:String((error&&error.message)||error)});
  }
};`;
