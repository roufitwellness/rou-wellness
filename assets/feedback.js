(function(){
  var box=document.querySelector('[data-feedback]'); if(!box) return;
  var url=box.getAttribute('data-feedback'); if(!url) return;
  function parse(t){var r=[],row=[],f='',q=false;for(var i=0;i<t.length;i++){var c=t[i];
    if(q){if(c=='"'){if(t[i+1]=='"'){f+='"';i++}else q=false}else f+=c}
    else if(c=='"')q=true;else if(c==','){row.push(f);f=''}
    else if(c=='\n'||c=='\r'){if(c=='\r'&&t[i+1]=='\n')i++;row.push(f);r.push(row);row=[];f=''}
    else f+=c}
    if(f!==''||row.length){row.push(f);r.push(row)}return r}
  fetch(url).then(function(x){return x.text()}).then(function(t){
    var rows=parse(t); if(rows.length<2) return;
    var h=rows[0].map(function(s){return s.trim()});
    var iPub=h.indexOf('公開');
    var iText=h.findIndex(function(s){return s.indexOf('老師說')>-1||s.indexOf('回饋')>-1&&s.indexOf('同意')<0});
    var iName=h.findIndex(function(s){return s.indexOf('稱呼')>-1});
    if(iPub<0||iText<0) return;
    var list=box.querySelector('.fb-list');
    var n=0;
    rows.slice(1).forEach(function(r){
      var ok=(r[iPub]||'').trim().toLowerCase();
      if(!(ok=='y'||ok=='yes'||ok=='是'||ok=='v'||ok=='✓')) return;
      var text=(r[iText]||'').trim(); if(!text) return;
      var fig=document.createElement('figure'); fig.className='fb-card';
      var bq=document.createElement('blockquote'); bq.textContent=text;
      var cap=document.createElement('figcaption'); cap.textContent='— '+((iName>=0&&(r[iName]||'').trim())||'學員');
      fig.appendChild(bq); fig.appendChild(cap); list.appendChild(fig); n++;
    });
    if(n) box.hidden=false;
  }).catch(function(){});
})();
