(function(){
  function $(id){return document.getElementById(id)}
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
  function show(id){['bk-pick','bk-done','bk-cancel'].forEach(function(x){$(x).hidden=(x!==id)});}
  function err(r){return r.json().then(function(j){return {ok:r.ok&&j.ok,j:j}},function(){return {ok:false,j:{}}})}
  var FAIL='連線失敗，請稍後再試。';

  // 取消預約（從預約成功時拿到的連結進來）
  var t=new URLSearchParams(location.search).get('cancel');
  if(t){
    show('bk-cancel');
    var info=$('bk-cancel-info'),cmsg=$('bk-cancel-msg'),cbtn=$('bk-cancel-btn');
    fetch('/api/booking/cancel?t='+encodeURIComponent(t)).then(err).then(function(x){
      if(!x.ok){info.textContent=x.j.error||FAIL;return}
      var d=x.j; info.textContent=d.name+'，你預約的是：'+d.service+'　'+d.when;
      if(d.status!=='booked'){cmsg.textContent='這筆預約已經取消了。';return}
      if(!d.canCancel){cmsg.textContent='開課前 '+d.cancelBeforeHours+' 小時內無法線上取消，請直接傳訊息給老師。';return}
      cbtn.hidden=false;
    }).catch(function(){info.textContent=FAIL});
    cbtn.addEventListener('click',function(){
      if(!confirm('確定要取消這堂課嗎？'))return;
      cbtn.disabled=true;
      fetch('/api/booking/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:t})})
      .then(err).then(function(x){
        if(x.ok){cbtn.hidden=true;cmsg.textContent='已經幫你取消了，謝謝你提早告知。'}
        else{cmsg.textContent=x.j.error||FAIL;cbtn.disabled=false}
      }).catch(function(){cmsg.textContent=FAIL;cbtn.disabled=false});
    });
    return;
  }

  var slots=[],filter='',chosen=null;
  var list=$('bk-slots'),form=$('bk-form'),fmsg=$('bk-msg');

  function fetchSlots(){
    show('bk-pick');
    return fetch('/api/booking/slots').then(err).then(function(x){
      if(!x.ok){list.textContent='';list.appendChild(el('p','fb-err',x.j.error||FAIL));return}
      slots=x.j.items||[];
      $('bk-rule').textContent='開課前 '+x.j.bookBeforeHours+' 小時停止線上預約；開課前 '+x.j.cancelBeforeHours+' 小時以前可以自己取消。';
      render();
    }).catch(function(){list.textContent='';list.appendChild(el('p','fb-err',FAIL))});
  }

  function render(){
    // 服務篩選
    var svcs=[];slots.forEach(function(s){if(svcs.indexOf(s.service)<0)svcs.push(s.service)});
    if(filter&&svcs.indexOf(filter)<0)filter='';
    var bar=$('bk-filter');bar.textContent='';bar.hidden=svcs.length<2;
    [''].concat(svcs).forEach(function(s){
      var b=el('button','fchip'+(filter===s?' on':''),s||'全部');b.type='button';
      b.setAttribute('aria-pressed',filter===s?'true':'false');
      b.addEventListener('click',function(){filter=s;render()});bar.appendChild(b);
    });
    list.textContent='';
    var items=slots.filter(function(s){return !filter||s.service===filter});
    if(!items.length){list.appendChild(el('p','lead','目前沒有可以預約的時段，老師開放新時段後會再更新。也歡迎直接傳訊息詢問。'));return}
    var day='',grid;
    items.forEach(function(s){
      if(s.date!==day){day=s.date;list.appendChild(el('h3','bk-day',s.when.split('）')[0]+'）'));grid=el('div','bk-grid');list.appendChild(grid)}
      var b=el('button','bk-slot'+(chosen&&chosen.id===s.id?' on':''));b.type='button';
      b.appendChild(el('span','t',s.when.split('）')[1]));
      b.appendChild(el('span','s',s.service));
      b.appendChild(el('span','n',s.left>0?(s.service.indexOf('一對一')>=0?'可預約':'剩 '+s.left+' 位'):'已額滿'));
      if(s.left<=0){b.disabled=true}
      else b.addEventListener('click',function(){chosen=s;render();openForm()});
      grid.appendChild(b);
    });
  }

  function openForm(){
    $('bk-chosen').textContent=chosen.service+'　'+chosen.when;
    form.hidden=false;fmsg.textContent='';
    form.scrollIntoView({behavior:'smooth',block:'start'});
    setTimeout(function(){form.name.focus({preventScroll:true})},300);
  }


  form.addEventListener('submit',function(e){
    e.preventDefault();if(!chosen)return;
    var btn=form.querySelector('button[type=submit]');btn.disabled=true;fmsg.textContent='';
    fetch('/api/booking',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      slot_id:chosen.id,name:form.name.value,email:form.email.value,contact:form.contact.value,note:form.note.value,hp:form.hp.value})})
    .then(err).then(function(x){
      btn.disabled=false;
      if(x.ok){
        try{localStorage.setItem('rou-booking-name',form.name.value);localStorage.setItem('rou-booking-email',form.email.value);localStorage.setItem('rou-booking-contact',form.contact.value)}catch(e){}
        var d=x.j,link=location.origin+'/booking/?cancel='+encodeURIComponent(d.token);
        $('bk-done-what').textContent=d.service+'　'+d.when;
        $('bk-done-mail').textContent=d.mail?'確認信已寄到 '+d.email+'，裡面也有取消連結。沒收到的話請看一下垃圾郵件匣。':'';
        var a=$('bk-done-link');a.href=link;a.textContent=link;
        show('bk-done');window.scrollTo(0,0);return;
      }
      fmsg.textContent=x.j.error||FAIL;
      if(x.j.full){chosen=null;form.hidden=true;fetchSlots()}
    }).catch(function(){btn.disabled=false;fmsg.textContent=FAIL});
  });
  $('bk-copy').addEventListener('click',function(){
    var link=$('bk-done-link').href,b=this;
    (navigator.clipboard?navigator.clipboard.writeText(link):Promise.reject()).then(function(){b.textContent='已複製'},function(){b.textContent='請長按連結複製'});
  });
  $('bk-again').addEventListener('click',function(){chosen=null;form.hidden=true;form.note.value='';fetchSlots()});

  try{form.name.value=localStorage.getItem('rou-booking-name')||'';form.email.value=localStorage.getItem('rou-booking-email')||'';form.contact.value=localStorage.getItem('rou-booking-contact')||''}catch(e){}
  fetchSlots();
})();
