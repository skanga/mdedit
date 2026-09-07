(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';
  function installDesktopWorkspace({document,nativeApp,controller,setStatus,onReload}) {
    if (!nativeApp) return null;
    const win=document.defaultView;
    const menu=document.createElement('div');
    menu.id='document-menu'; menu.className='document-menu'; menu.hidden=true;
    menu.setAttribute('role','menu'); menu.setAttribute('aria-label','Document actions');
    for (const [action,label] of [['reopen','Reopen closed tab'],['copy','Copy file path'],['reveal','Show in file manager'],['save-as','Save As…'],['close','Close tab']]) {
      const button=document.createElement('button');button.type='button';button.dataset.action=action;
      button.setAttribute('role','menuitem');button.textContent=label;menu.append(button);
    }
    document.body.append(menu);
    const banner=document.createElement('div');banner.className='external-banner';banner.hidden=true;
    banner.setAttribute('role','status');
    const message=document.createElement('span'),compare=document.createElement('button');
    compare.type='button';compare.textContent='Compare changes';banner.append(message,compare);
    document.getElementById('document-tabs').parentElement.after(banner);
    const dialog=document.createElement('dialog');dialog.id='external-comparison';
    dialog.setAttribute('aria-labelledby','comparison-title');
    dialog.innerHTML='<h2 id="comparison-title">File changed on disk</h2><p class="comparison-name"></p><div class="comparison-columns"><label>Your edits<textarea readonly aria-label="Your edits" spellcheck="false"></textarea></label><label>Disk version<textarea readonly aria-label="Disk version" spellcheck="false"></textarea></label></div><p>Your edits stay unchanged until you choose an action.</p><div class="comparison-actions"><button data-action="keep-editing">Keep editing</button><button data-action="save-as">Save As…</button><button data-action="reload">Reload from disk…</button></div>';
    document.body.append(dialog);
    let targetId=null,menuOwner=null,comparisonId=null;
    function closeMenu(focus=false) { menu.hidden=true;if(focus && menuOwner?.isConnected)menuOwner.focus(); }
    function openMenu(owner,x,y) {
      targetId=owner.dataset.documentId;menuOwner=owner;
      const model=controller.session?.documents.get(targetId);if(!model)return;
      menu.querySelector('[data-action="reopen"]').disabled=!controller.canReopenClosedDocument();
      for(const action of ['copy','reveal'])menu.querySelector(`[data-action="${action}"]`).disabled=!model.path;
      menu.hidden=false;
      menu.style.left=Math.max(4,Math.min(x,win.innerWidth-menu.offsetWidth-4))+'px';
      menu.style.top=Math.max(4,Math.min(y,win.innerHeight-menu.offsetHeight-4))+'px';
      menu.querySelector('button:not(:disabled)').focus();
    }
    const tabbar=document.getElementById('document-tabs');
    tabbar.addEventListener('contextmenu',event=>{
      const owner=event.target.closest('[role="tab"]');if(!owner)return;
      event.preventDefault();openMenu(owner,event.clientX,event.clientY);
    });
    tabbar.addEventListener('keydown',event=>{
      if(event.key!=='ContextMenu' && !(event.key==='F10'&&event.shiftKey))return;
      const owner=event.target.closest('[role="tab"]');if(!owner)return;
      event.preventDefault();const rect=owner.getBoundingClientRect();openMenu(owner,rect.left,rect.bottom);
    });
    menu.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();closeMenu(true);return;}
      if(event.key==='Tab'){closeMenu();return;}
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      event.preventDefault();const items=[...menu.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);
      items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
    });
    document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))closeMenu();});
    win.addEventListener('resize',()=>closeMenu());
    async function reopen() {
      try { const result=await controller.reopenClosedDocument();if(result.error)setStatus(result.error.message||String(result.error)); }
      catch(error){setStatus(error.message||String(error));}
    }
    menu.addEventListener('click',async event=>{
      const action=event.target.closest('button')?.dataset.action;if(!action)return;
      const model=controller.session?.documents.get(targetId);closeMenu(true);if(!model)return;
      try {
        if(action==='reopen')await reopen();
        else if(action==='copy'){await win.navigator.clipboard.writeText(model.path);setStatus('Copied file path');}
        else if(action==='reveal')await nativeApp.revealDocument(model.path);
        else if(action==='save-as')await controller.saveAs(model.id);
        else if(action==='close')await controller.closeDocument(model.id);
      }catch(error){setStatus(error.message||String(error));}
      refresh();
    });
    document.addEventListener('keydown',event=>{
      if((event.ctrlKey||event.metaKey)&&event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='t'&&!document.querySelector('dialog[open]')){
        event.preventDefault();reopen();
      }
    });
    function refresh() {
      const model=controller.activeDocument();
      const conflict=model && controller.externalVersion(model.id);
      const missing=model?.fileStatus==='missing';
      banner.hidden=!conflict&&!missing;
      message.textContent=missing?'This file is missing on disk. Use Save As to keep a copy.':conflict?`${model.displayName} changed outside MDedit. Your edits are preserved.`:'';
      compare.hidden=!conflict;
    }
    compare.addEventListener('click',()=>{
      const model=controller.activeDocument(),disk=model&&controller.externalVersion(model.id);if(!disk)return;
      comparisonId=model.id;
      dialog.querySelector('.comparison-name').textContent=model.path;
      dialog.querySelector('[aria-label="Your edits"]').value=model.content;
      dialog.querySelector('[aria-label="Disk version"]').value=disk.content;
      dialog.showModal();dialog.querySelector('[data-action="keep-editing"]').focus();
    });
    dialog.addEventListener('click',async event=>{
      const action=event.target.closest('[data-action]')?.dataset.action;if(!action)return;
      const id=comparisonId;dialog.close();
      try { await controller.resolveConflict(id,action); }catch(error){setStatus(error.message||String(error));}
      refresh();
    });
    let checking=false;
    async function check() {
      if(checking||document.hidden||dialog.open)return;
      checking=true;
      try {
        const events=await controller.checkExternalChanges();
        if(events.some(event=>event.status==='reloaded'))onReload?.();
        refresh();
      }catch(error){setStatus(error.message||String(error));}
      finally{checking=false;}
    }
    const timer=win.setInterval(check,3000);win.addEventListener('focus',check);
    win.addEventListener('pagehide',()=>{win.clearInterval(timer);win.removeEventListener('focus',check);},{once:true});
    refresh();
    return {refresh,check};
  }
  return {installDesktopWorkspace};
});
