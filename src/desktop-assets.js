(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';
  function createDesktopAssets({document,nativeApp,controller,activeEditor,replaceRange,onChange,setStatus}) {
    if (!nativeApp) return null;
    const win = document.defaultView, cache = new Map();
    let importing = false, cacheBytes = 0;
    const relative = reference => reference && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(reference);
    async function dataUrl(path,reference,fresh=false) {
      const key = path + '\0' + reference;
      const cached=cache.get(key);
      if (!fresh && cached && Date.now()-cached.createdAt<3000) return cached;
      if (cached) { cacheBytes-=cached.url.length;cache.delete(key); }
      const asset = await nativeApp.readDocumentAsset(path,reference.split(/[?#]/)[0]);
      const result = await new Promise((resolve,reject) => {
        const reader = new win.FileReader(); reader.onload = () => resolve({url:reader.result,mime:asset.mime}); reader.onerror=()=>reject(reader.error);
        reader.readAsDataURL(new win.Blob([new Uint8Array(asset.bytes)],{type:asset.mime}));
      });
      if (result.url.length < 32*1024*1024) {
        while (cacheBytes + result.url.length > 32*1024*1024 && cache.size) { const key=cache.keys().next().value; cacheBytes-=cache.get(key).url.length; cache.delete(key); }
        result.createdAt=Date.now();cache.set(key,result); cacheBytes+=result.url.length;
      }
      return result;
    }
    async function hydrate(root,path,isCurrent,forExport=false) {
      if (!path) return;
      for (const el of root.querySelectorAll('img[src],a[href]')) {
        const image = el.tagName === 'IMG', attr = image?'src':'href', reference=el.getAttribute(attr);
        if (!relative(reference)) continue;
        if (!image && !forExport) { el.dataset.localReference=reference; continue; }
        try {
          const asset=await dataUrl(path,reference,forExport); if (!isCurrent()) return;
          if (image && !asset.mime.startsWith('image/')) throw new Error('This file is not a supported image');
          el.setAttribute(attr,asset.url);
          if (image) await el.decode();
          if (!image) el.setAttribute('download',decodeURIComponent(reference.split(/[?#]/)[0]).split('/').pop());
        } catch (error) {
          if (forExport) throw new Error(`Could not include ${reference}: ${error.message || error}`);
          if (isCurrent()) { el.title=`Could not load ${reference}`; el.classList.add('asset-unavailable'); }
        }
      }
    }
    const label = name => String(name).replace(/[\r\n]/g,' ').replace(/[\\[\]]/g,'\\$&');
    const uri = path => path.split('/').map(part=>encodeURIComponent(part).replace(/[()]/g,c=>'%'+c.charCodeAt(0).toString(16))).join('/');
    async function importFiles(files, nativePaths=false) {
      if (importing || !files.length || document.querySelector('dialog[open],#app-dialog:not([hidden])')) return;
      importing=true;
      const model=controller.activeDocument();
      const original=activeEditor();
      if (!model || !original) { importing=false; return; }
      const initialRevision=model.editRevision;
      let from=original.selectionStart,to=original.selectionEnd;
      try {
        if (!model.path) {
          const saved=await controller.saveAs(model.id);
          if (!saved?.saved) return;
        }
        const path=model.path;
        let revision=initialRevision;
        const current=()=>controller.activeDocument()===model && model.path===path && model.editRevision===revision && activeEditor()===original;
        if (!current()) throw new Error('Document changed before the attachment could be inserted');
        for (const file of files) {
          if (!current()) throw new Error('Document changed before the attachment could be inserted');
          if (!nativePaths && file.size > 20*1024*1024) throw new Error("Attachments must be 20 MiB or smaller");
          const name=nativePaths?file.split(/[\\/]/).pop():file.name;
          const asset=nativePaths?await nativeApp.importDocumentAttachment(path,file)
            :await nativeApp.importDocumentAsset(path,name,new Uint8Array(await file.arrayBuffer()));
          if (!current()) throw new Error(`Document changed. The attachment was saved as ${asset.relativePath}; its link was not inserted.`);
          const markdown=(asset.mime.startsWith('image/')?'!':'')+'['+label(name)+']('+uri(asset.relativePath)+')';
          replaceRange(original,from,to,markdown+'\n'); onChange();
          revision=model.editRevision; from=to=original.selectionEnd;
        }
        setStatus('Inserted '+files.length+' attachment'+(files.length===1?'':'s'));
      } catch(error) { setStatus(error.message || String(error)); }
      finally { importing=false; }
    }
    const attach=document.getElementById('btn-attach'); attach.hidden=false;
    attach.addEventListener('click', async()=>{
      const model=controller.activeDocument(),revision=model?.editRevision;
      try {
        const paths=await nativeApp.pickAttachments();
        if (controller.activeDocument()!==model || model?.editRevision!==revision) throw new Error('Document changed while choosing attachments');
        await importFiles(paths,true);
      } catch(error) { setStatus(error.message || String(error)); }
    });
    document.getElementById('editor-surfaces').addEventListener('paste',event=>{
      if(event.target!==activeEditor())return;
      const files=[...(event.clipboardData?.files || [])].filter(file=>file.type.startsWith('image/'));
      if(files.length){event.preventDefault();importFiles(files);}
    });
    document.addEventListener('drop',event=>{
      const files=[...(event.dataTransfer?.files || [])];
      if(!files.length || files.every(file=>/\.(md|markdown|mdown|mkd|txt)$/i.test(file.name)))return;
      event.preventDefault();event.stopImmediatePropagation();document.getElementById('drop-overlay').classList.remove('on');
      importFiles(files);
    },true);
    document.getElementById('preview').addEventListener('click',async event=>{
      const anchor=event.target.closest('a[data-local-reference]');if(!anchor)return;
      event.preventDefault();const model=controller.activeDocument();if(!model?.path)return;
      try {
        const asset=await dataUrl(model.path,anchor.dataset.localReference);
        const a=document.createElement('a');a.href=asset.url;a.download=decodeURIComponent(anchor.dataset.localReference).split('/').pop();a.click();
      }catch(error){setStatus(error.message || String(error));}
    });
    const nativeWindow=win.__TAURI__?.window?.getCurrentWindow?.();
    if(nativeWindow?.onDragDropEvent) nativeWindow.onDragDropEvent(async event=>{
      const overlay=document.getElementById('drop-overlay');
      if(event.payload.type==='enter')overlay.classList.add('on');
      if(event.payload.type==='leave'||event.payload.type==='drop')overlay.classList.remove('on');
      if(event.payload.type!=='drop')return;
      const paths=event.payload.paths;
      const docs=paths.filter(path=>/\.(md|markdown|mdown|mkd|txt)$/i.test(path));
      const assets=paths.filter(path=>!docs.includes(path));
      if(assets.length) await importFiles(assets,true);
      if(docs.length)controller.openPaths(docs).catch(error=>setStatus(error.message));
    }).catch(error=>setStatus('Could not enable file drop: '+error.message));
    return {hydrate,importFiles,clearCache(){cache.clear();cacheBytes=0;}};
  }
  return {createDesktopAssets};
});
