const API = '';
let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user')||'null');
let editingId = null;
let monthlyChart, categoryChart;
const CATEGORIES = ['Food','Transport','Entertainment','Bills','Shopping','Health','Other'];
const $ = id => document.getElementById(id);

function headers(){ return {'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})} }

function setAuthMode(mode){
  const isReg = mode==='register';
  $('email-field').style.display = isReg ? 'flex' : 'none';
  $('auth-email').required = isReg;
  $('tab-login').classList.toggle('active', !isReg);
  $('tab-register').classList.toggle('active', isReg);
  $('auth-submit').textContent = isReg ? 'Create account →' : 'Sign in →';
  $('auth-form').dataset.mode = mode;
}
$('tab-login').onclick=()=>setAuthMode('login');
$('tab-register').onclick=()=>setAuthMode('register');
setAuthMode('login');

$('auth-form').onsubmit=async e=>{
  e.preventDefault();
  const mode = e.target.dataset.mode;
  const username = $('auth-username').value.trim();
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  $('auth-error').textContent='';
  const payload = mode==='register' ? {username,email,password} : {username,password};
  if(mode==='register' && !email){ $('auth-error').textContent='Email required'; return; }
  try{
    const r = await fetch(`/api/auth/${mode}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    const j = await r.json();
    if(!r.ok) throw new Error(j.error||'Failed');
    token=j.token; user=j.user;
    localStorage.setItem('token',token); localStorage.setItem('user',JSON.stringify(user));
    showDashboard();
  }catch(err){ $('auth-error').textContent=err.message }
};

$('logout').onclick=()=>{
  localStorage.clear(); token=null; user=null; showAuth();
};

function showAuth(){
  $('auth-view').style.display='grid';
  $('dashboard').style.display='none';
}
function showDashboard(){
  $('auth-view').style.display='none';
  $('dashboard').style.display='block';
  if(user){ $('user-badge').textContent='@'+user.username; $('user-email').textContent=user.email }
  initDashboard();
}

function initDashboard(){
  // populate categories
  const catSel = $('exp-category'); const filtSel=$('filter-cat');
  catSel.innerHTML=''; filtSel.innerHTML='<option value="All">All categories</option>';
  CATEGORIES.forEach(c=>{
    catSel.innerHTML+=`<option value="${c}">${c}</option>`;
    filtSel.innerHTML+=`<option value="${c}">${c}</option>`;
  });
  // defaults
  $('exp-date').valueAsDate = new Date();
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  $('cat-month').value = curMonth;
  $('filter-month').value = '';
  // year select
  const ys = $('year-select'); ys.innerHTML='';
  for(let y=now.getFullYear(); y>=2022; y--) ys.innerHTML+=`<option value="${y}" ${y===now.getFullYear()?'selected':''}>${y}</option>`;
  refreshAll();
}

async function refreshAll(){
  await Promise.all([loadExpenses(), loadStats(), loadMonthly(), loadCategory()]);
}

async function loadStats(){
  const r = await fetch('/api/expenses/stats/summary',{headers:headers()});
  if(!r.ok) return;
  const s = await r.json();
  $('stat-current').textContent = `$${s.currentTotal.toFixed(2)}`;
  $('stat-total').textContent = `$${s.allTotal.toFixed(2)}`;
  $('stat-count').textContent = `${s.count} transactions`;
  const diff = s.currentTotal - s.prevTotal;
  const pct = s.prevTotal? ((diff/s.prevTotal)*100).toFixed(1): (s.currentTotal>0?'100': '0');
  const el = $('stat-change');
  if(s.prevTotal===0 && s.currentTotal===0){ el.textContent='No prior data'; el.className='trend';}
  else {
    const up = diff>=0;
    el.textContent = `${diff>=0?'+':''}${pct}% vs last month`;
    el.className='trend '+(up?'down':'up'); // spending up is bad -> red, down green - invert
    if(diff<=0) el.className='trend up'; else el.className='trend down';
  }
  // progress bar based on current vs avg
  const avg = s.count? s.allTotal / (12) : 1;
  const w = Math.min(100, (s.currentTotal/Math.max(avg*1.5,1))*100 );
  $('progress-bar').style.width = w+'%';
  $('progress-label').textContent = s.currentTotal>avg*1.2 ? 'Above average spending' : 'Within healthy range';
  // top category
  const rc = await fetch(`/api/expenses/stats/category?month=${$('cat-month').value}`,{headers:headers()});
  if(rc.ok){
    const cj = await rc.json();
    if(cj.breakdown.length){ $('stat-top').textContent=cj.breakdown[0].category; $('stat-top-amt').textContent=`$${cj.breakdown[0].total.toFixed(2)} this month`; }
    else { $('stat-top').textContent='—'; $('stat-top-amt').textContent='No data';}
  }
}

async function loadMonthly(){
  const year = $('year-select').value;
  const r = await fetch(`/api/expenses/stats/monthly?year=${year}`,{headers:headers()});
  const data = await r.json();
  const labels = data.map(d=>d.label);
  const totals = data.map(d=>d.total);
  if(monthlyChart) monthlyChart.destroy();
  monthlyChart = new Chart($('monthlyChart'), {
    type:'bar',
    data:{labels, datasets:[{label:'Spending', data:totals, backgroundColor:'rgba(99,102,241,.85)', borderRadius:8, borderSkipped:false}]},
    options:{
      responsive:true,
      plugins:{legend:{display:false}},
      scales:{
        y:{grid:{color:'rgba(255,255,255,.06)'}, ticks:{color:'#9ca3af', callback:v=>'$'+v}, beginAtZero:true},
        x:{grid:{display:false}, ticks:{color:'#9ca3af'}}
      }
    }
  });
}

async function loadCategory(){
  const month = $('cat-month').value;
  const r = await fetch(`/api/expenses/stats/category?month=${month}`,{headers:headers()});
  const j = await r.json();
  const labels = j.breakdown.map(b=>b.category);
  const totals = j.breakdown.map(b=>b.total);
  const colors = {Food:'#fb923c',Transport:'#38bdf8',Entertainment:'#a855f7',Bills:'#ef4444',Shopping:'#ec4899',Health:'#10b981',Other:'#94a3b8'};
  const bg = labels.map(l=>colors[l]||'#64748b');
  if(categoryChart) categoryChart.destroy();
  categoryChart = new Chart($('categoryChart'), {
    type:'doughnut',
    data:{labels, datasets:[{data:totals.length?totals:[1], backgroundColor:totals.length?bg:['#1f2937'], borderWidth:0}]},
    options:{cutout:'64%', plugins:{legend:{display:false}}}
  });
  const legend = $('category-legend'); legend.innerHTML='';
  if(!j.breakdown.length){ legend.innerHTML='<span class="muted">No expenses this month</span>'; return; }
  j.breakdown.forEach(b=>{
    const pct = j.total? ((b.total/j.total)*100).toFixed(1):0;
    legend.innerHTML+=`<span><b style="color:${colors[b.category]}">●</b> ${b.category} $${b.total.toFixed(2)} (${pct}%)</span>`;
  });
}

// Expenses CRUD
async function loadExpenses(){
  const cat = $('filter-cat').value;
  const month = $('filter-month').value;
  const search = $('filter-search').value;
  let url='/api/expenses?';
  if(month) url+=`month=${month}&`;
  if(cat && cat!=='All') url+=`category=${cat}&`;
  if(search) url+=`search=${encodeURIComponent(search)}&`;
  const r = await fetch(url,{headers:headers()});
  const list = await r.json();
  const tbody=$('expense-list'); tbody.innerHTML='';
  if(!list.length){ $('empty-state').style.display='block'; } else { $('empty-state').style.display='none'; }
  list.forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td>${e.date}</td>
      <td>${escapeHtml(e.description)}</td>
      <td><span class="cat ${e.category}">${e.category}</span></td>
      <td style="font-family:JetBrains Mono,monospace;font-weight:700">$${Number(e.amount).toFixed(2)}</td>
      <td><div class="actions"><button class="icon-btn" data-edit="${e.id}">Edit</button><button class="icon-btn" data-del="${e.id}">Delete</button></div></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('[data-del]').forEach(b=> b.onclick=async()=>{
    if(!confirm('Delete this expense?')) return;
    await fetch(`/api/expenses/${b.dataset.del}`,{method:'DELETE', headers:headers()});
    refreshAll();
  });
  tbody.querySelectorAll('[data-edit]').forEach(b=> b.onclick=()=>{
    const ex = list.find(x=>x.id==b.dataset.edit);
    editingId=ex.id;
    $('exp-amount').value=ex.amount;
    $('exp-category').value=ex.category;
    $('exp-desc').value=ex.description;
    $('exp-date').value=ex.date;
    $('exp-submit').textContent='Update Expense';
    $('exp-cancel').style.display='block';
    window.scrollTo({top:0, behavior:'smooth'});
  });
}

function escapeHtml(s){ return s.replace(/[&<>"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])) }

$('expense-form').onsubmit=async e=>{
  e.preventDefault();
  const body={
    amount: parseFloat($('exp-amount').value),
    category: $('exp-category').value,
    description: $('exp-desc').value.trim(),
    date: $('exp-date').value
  };
  const url = editingId? `/api/expenses/${editingId}` : '/api/expenses';
  const method = editingId? 'PUT':'POST';
  const r = await fetch(url,{method, headers:headers(), body:JSON.stringify(body)});
  const j = await r.json();
  if(!r.ok){ alert(j.error||'Failed'); return; }
  editingId=null; $('exp-submit').textContent='Add Expense'; $('exp-cancel').style.display='none';
  e.target.reset(); $('exp-date').valueAsDate=new Date();
  refreshAll();
};
$('exp-cancel').onclick=()=>{
  editingId=null; $('exp-submit').textContent='Add Expense'; $('exp-cancel').style.display='none';
  $('expense-form').reset(); $('exp-date').valueAsDate=new Date();
};

// filters
$('filter-cat').onchange=loadExpenses;
$('filter-month').onchange=loadExpenses;
$('filter-search').oninput=debounce(loadExpenses,300);
$('cat-month').onchange=()=>{loadCategory(); loadStats();};
$('year-select').onchange=loadMonthly;

function debounce(fn,ms){ let t; return (...a)=>{clearTimeout(t); t=setTimeout(()=>fn(...a),ms)} }

// init auth check
(async ()=>{
  if(token){
    try{
      const r=await fetch('/api/auth/me',{headers:headers()});
      if(r.ok){ user=await r.json(); localStorage.setItem('user',JSON.stringify(user)); showDashboard(); return;}
    }catch{}
    localStorage.clear();
  }
  showAuth();
})();
