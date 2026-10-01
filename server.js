// ============================================================
//  磁力影院 · 私有云盘服务（云端离线下载版）
//  部署在任意电脑/云主机上：磁力提交给云端下载，手机/浏览器在线播放
//  用法：TOKEN=你的密码 node server.js
//        然后手机 App「连接我的云盘」或浏览器打开 http://IP:3000
//  可选环境变量：
//    PORT=3000        监听端口
//    TOKEN=xxx        访问密码（强烈建议设置，不设置则任何人可访问）
//    DOWNLOAD_DIR=./downloads   下载存储目录
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebTorrent = require('webtorrent');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const TOKEN = (process.env.TOKEN || '').trim();
const TORRENT_DIR = process.env.DOWNLOAD_DIR ? path.resolve(process.env.DOWNLOAD_DIR) : path.join(__dirname, 'downloads');
if (!fs.existsSync(TORRENT_DIR)) fs.mkdirSync(TORRENT_DIR, { recursive: true });
const writeLog = (s) => { try { console.log(s); } catch (e) {} };

// 全局异常兜底：任何未捕获错误只记日志，不崩溃
process.on('uncaughtException', (err) => {
  writeLog('uncaughtException: ' + ((err && err.stack) || err));
});
process.on('unhandledRejection', (reason) => {
  writeLog('unhandledRejection: ' + ((reason && reason.stack) || reason));
});

// 访问鉴权：设置了 TOKEN 后，所有 API 必须带 X-Auth-Token 头或 ?t= 参数
function authed(req, url) {
  if (!TOKEN) return true;
  const h = req.headers['x-auth-token'] || '';
  const q = (url.searchParams.get('t') || '');
  return h === TOKEN || q === TOKEN;
}

// DNS 策略：优先使用系统 DNS（Wi-Fi/运营商各有自己的 DNS，通常最可靠）
// 仅当系统 DNS 解析失败时才切换到公共 DNS 兜底
try {
  const dns = require('dns');
  dns.lookup('tracker.opentrackr.org', { family: 4 }, (err) => {
    if (err) {
      try {
        dns.setServers(['223.5.5.5', '119.29.29.29', '8.8.8.8', '114.114.114.114']);
        writeLog('系统 DNS 解析失败，已切换公共 DNS');
      } catch (e) { writeLog('DNS 切换失败: ' + e.message); }
    } else {
      writeLog('系统 DNS 可用，使用系统默认配置');
    }
  });
} catch (e) { writeLog('DNS 初始化失败: ' + e.message); }

// 公共 tracker 列表：附加到每个磁力任务，提高节点发现成功率（HTTPS 通道更抗干扰）
const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.gbitt.info:443/announce',
  'udp://tracker.birkenfeld.one:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'http://tracker.opentrackr.org:1337/announce'
];

// 网络优化：utp:false 强制 TCP（uTP 在多数网络被限速/丢包，且占连接名额）；maxConns 靠多节点补速
const client = new WebTorrent({ maxConns: 200, utp: false });
// 关键：给客户端挂 error/warning 监听，DHT 等出错时只记日志，不销毁引擎
client.on('error', (err) => {
  writeLog('[client error] ' + ((err && err.message) || err));
  // 引擎内部已异常，主动退出，由宿主（MainActivity）自动重启，保证引擎始终健康
  setTimeout(() => { try { process.exit(0); } catch (e) {} }, 800);
});
client.on('warning', (err) => {
  writeLog('[client warning] ' + ((err && err.message) || err));
});
const torrents = new Map(); // infoHash(lower) -> torrent

// 心跳日志：每 10 秒确认引擎存活（用于定位崩溃时间点）
setInterval(() => { writeLog('alive'); }, 10000);

const VIDEO_EXT = ['mp4', 'webm', 'ogv', 'ogg', 'mov', 'mkv', 'avi', 'm4v', 'flv', 'wmv', 'ts', 'mpg', 'mpeg', '3gp', 'rmvb'];
const MIME = {
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg',
  mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  m4v: 'video/x-m4v', flv: 'video/x-flv', wmv: 'video/x-ms-wmv', ts: 'video/mp2t',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', rmvb: 'video/vnd.rn-realvideo'
};

function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }
function isVideo(name) { return VIDEO_EXT.indexOf(extOf(name)) >= 0; }
function isAudio(name) { return ['mp3','wav','flac','aac','ogg','m4a','wma'].indexOf(extOf(name)) >= 0; }
function fmtSize(b) {
  if (b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB']; let i = Math.floor(Math.log(b) / Math.log(1024));
  if (i >= u.length) i = u.length - 1;
  return (b / Math.pow(1024, i)).toFixed(i >= 2 ? 2 : 0) + ' ' + u[i];
}

function torrentState(t) {
  return {
    infoHash: t.infoHash,
    name: t.name || '未知种子',
    progress: t.progress || 0,
    downloadSpeed: t.downloadSpeed || 0,
    uploadSpeed: t.uploadSpeed || 0,
    numPeers: t.numPeers || 0,
    downloaded: t.downloaded || 0,
    length: t.length || 0,
    done: t.done || false,
    paused: !!t.paused,
    files: (t.files || []).map((f, i) => ({
      index: i, name: f.name, path: f.path, length: f.length,
      video: isVideo(f.name), audio: isAudio(f.name)
    }))
  };
}

// ================= 路由处理 =================
function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
    res.end(data);
  });
}

function handleAdd(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 100000) req.destroy(); });
  req.on('end', () => {
    let magnet = '';
    try { magnet = JSON.parse(body).magnet || ''; } catch (e) { magnet = body.trim(); }
    magnet = (magnet || '').trim();
    if (!magnet) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '磁力链接为空' }));
      return;
    }
    // 已有该种子则直接返回（任务列表里的）
    const existing = Array.from(torrents.values()).find(t => magnet.indexOf(t.infoHash) >= 0);
    if (existing) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, infoHash: existing.infoHash, name: existing.name, duplicated: true }));
      return;
    }
    // 引擎内部正在连接（尚未 ready、未进任务列表）的同一种子也视为已存在，
    // 避免 client.add 抛 "Cannot add duplicate torrent" 报错
    const btih = (magnet.match(/btih:([a-fA-F0-9]{40})/) || [])[1];
    if (btih) {
      const pending = client.torrents.find(t => t.infoHash && t.infoHash.toLowerCase() === btih.toLowerCase());
      if (pending) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, infoHash: pending.infoHash, name: pending.name || '正在连接节点…', duplicated: true, pending: true }));
        return;
      }
    }
    let torrent;
    try {
      torrent = client.add(magnet, { path: TORRENT_DIR, announce: EXTRA_TRACKERS });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '磁力链接格式错误：' + e.message }));
      return;
    }
    // 60 秒内未获取到元数据则提示（前端会自动重试）
    const timer = setTimeout(() => {
      if (!torrent.infoHash || !torrents.has(torrent.infoHash)) {
        try { client.remove(torrent); } catch (e) {}
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '获取种子元数据超时：请确认种子有做种者。若当前网络失败，可切换 Wi-Fi/移动网络重试（部分宽带会干扰 BT 流量）' }));
      }
    }, 60000);

    torrent.on('ready', () => {
      clearTimeout(timer);
      torrents.set(torrent.infoHash.toLowerCase(), torrent);
      console.log('[添加成功]', torrent.name, '|', fmtSize(torrent.length), '|', torrent.files.length, '个文件');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, infoHash: torrent.infoHash, name: torrent.name, state: torrentState(torrent) }));
    });
    torrent.on('error', (err) => {
      clearTimeout(timer);
      console.error('[种子错误]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '种子错误：' + err.message }));
    });
    torrent.on('warning', (err) => console.warn('[警告]', err.message));
    console.log('[添加任务]', magnet.slice(0, 60) + '...');
  });
}

function handleStatus(res) {
  const list = [];
  torrents.forEach(t => { try { list.push(torrentState(t)); } catch (e) {} });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, count: list.length, torrents: list }));
}

// 活动播放流登记：只做清理登记，绝不在新请求时销毁旧流（并发请求是正常行为，销毁会导致断流报错）
const activeStreams = new Map();

function handleStream(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['stream', infoHash, fileIndex]
  if (parts.length < 3) { res.writeHead(400); res.end('Bad Request'); return; }
  const infoHash = parts[1].toLowerCase();
  const fileIndex = parseInt(parts[2], 10);
  if (isNaN(fileIndex)) { res.writeHead(400); res.end('Bad Request'); return; }

  let torrent = torrents.get(infoHash);
  if (!torrent) torrent = client.get(infoHash);
  if (!torrent) { res.writeHead(404); res.end('种子不存在'); return; }
  const file = torrent.files[fileIndex];
  if (!file) { res.writeHead(404); res.end('文件不存在'); return; }

  const fileSize = file.length;
  const mime = MIME[extOf(file.name)] || 'application/octet-stream';
  const range = req.headers.range;
  const streamKey = infoHash + ':' + fileIndex;

  // 解析 Range，兼容 bytes=start- / bytes=-suffix / bytes=start-end
  let start = 0, end = fileSize - 1;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m && m[1] !== '' && m[2] !== '') {
      start = parseInt(m[1], 10); end = parseInt(m[2], 10);
    } else if (m && m[1] !== '' && m[2] === '') {
      start = parseInt(m[1], 10); end = fileSize - 1;
    } else if (m && m[1] === '' && m[2] !== '') {
      const suf = parseInt(m[2], 10); start = Math.max(0, fileSize - suf); end = fileSize - 1;
    }
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= fileSize) end = fileSize - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + fileSize }); res.end(); return; }
  }

  const isRange = !!range;
  // 始终以 206 分段响应（流媒体标准行为）：无 Range 也按 bytes 0-end 处理，
  // 浏览器才能边下边播、随意拖动。若返回 200 全文件，WebView 会等待整文件下载并超时报错。
  res.writeHead(206, {
    'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': mime,
    'Cache-Control': 'no-store'
  });

  const stream = file.createReadStream({ start: start, end: end });
  activeStreams.set(streamKey, stream);
  const cleanup = () => {
    if (activeStreams.get(streamKey) === stream) activeStreams.delete(streamKey);
  };
  stream.on('error', () => { try { res.destroy(); } catch (e) {} });
  stream.on('close', cleanup);
  stream.on('end', cleanup);
  stream.pipe(res);
  console.log('[播放]', file.name, '| 偏移', range || '从头');
}

function handleRemove(req, res, url) {
  const hash = (url.searchParams.get('hash') || '').toLowerCase();
  const t = torrents.get(hash);
  if (!t) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '种子不存在' })); return; }
  try { client.remove(t); } catch (e) {}
  torrents.delete(hash);
  console.log('[移除]', t.name);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// 上传已下载文件到 WebDAV 网盘（坚果云 / Nextcloud / 群晖等）
const httpsMod = require('https');
const httpMod = require('http');

function handleWebdavUpload(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 100000) req.destroy(); });
  req.on('end', () => {
    let data = {};
    try { data = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '参数格式错误' })); return;
    }
    const relPath = (data.relPath || '').replace(/\.\./g, '');
    const url = (data.url || '').trim();
    const user = (data.user || '').trim();
    const pass = (data.pass || '');
    if (!relPath || !url || !user || !pass) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '缺少文件或网盘配置' })); return;
    }
    // 连接探测：不依赖本地文件，直接 PUT 一小段文本
    const isProbe = relPath === '__probe__';
    const srcFile = path.join(TORRENT_DIR, relPath);
    if (!isProbe && !fs.existsSync(srcFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '文件不存在或未下载完成' })); return;
    }
    let target;
    try { target = new URL(url.endsWith('/') ? url + path.basename(relPath) : url); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '网盘地址格式错误' })); return;
    }
    const mod = target.protocol === 'https:' ? httpsMod : httpMod;
    const size = isProbe ? 16 : fs.statSync(srcFile).size;
    const opts = {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'PUT',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64'),
        'Content-Length': size,
        'User-Agent': 'MagnetPlayer/1.0'
      }
    };
    const r = mod.request(opts, (resp) => {
      let out = '';
      resp.on('data', c => { out += c; });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: isProbe ? '连接正常' : path.basename(relPath) }));
        } else {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '网盘返回 ' + resp.statusCode + '：' + out.slice(0, 200) }));
        }
      });
    });
    r.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '连接网盘失败：' + e.message }));
    });
    if (isProbe) {
      r.end('magnet probe ok');
    } else {
      fs.createReadStream(srcFile).pipe(r);
    }
  });
}

// 暂停/继续下载
function handlePauseResume(req, res, url, mode) {
  const hash = (url.searchParams.get('hash') || '').toLowerCase();
  const t = torrents.get(hash);
  if (!t) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '种子不存在' })); return; }
  try {
    if (mode === 'pause') {
      // 引擎的 pause() 只是不再连新节点，已连接的节点仍继续传数据；
      // 所以暂停时同时断开所有已连接节点，下载才真正停止
      (t.wires || []).slice().forEach(function (wire) {
        try { wire.destroy(); } catch (e) {}
      });
      t.pause();
    } else {
      t.resume();
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, paused: mode === 'pause' }));
}

// 选择/取消选择文件（want=1 只下载该文件并停掉其他；want=0 停止下载该文件）
function handleSelect(req, res, url) {
  const hash = (url.searchParams.get('hash') || '').toLowerCase();
  const index = parseInt(url.searchParams.get('index'), 10);
  const want = parseInt(url.searchParams.get('want'), 10);
  const t = torrents.get(hash);
  if (!t) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '种子不存在' })); return; }
  const file = t.files[index];
  if (!file) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '文件不存在' })); return; }
  try {
    if (want === 1) {
      // 只下载该文件：选中它，停掉其他所有文件
      t.files.forEach((f, i) => {
        try { if (i === index) f.select(); else f.deselect(); } catch (e) {}
      });
    } else {
      file.deselect();
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, selected: want === 1 }));
}

// ================= 服务器 =================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') return serveStatic(res, path.join(__dirname, 'public', 'index.html'), 'text/html');
    if (p === '/style.css') return serveStatic(res, path.join(__dirname, 'public', 'style.css'), 'text/css');
    if (p === '/app.js') return serveStatic(res, path.join(__dirname, 'public', 'app.js'), 'application/javascript');
    if (p === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, t: Date.now() }));
      return;
    }
    // 所有 /api 与 /stream 必须通过鉴权（未设置 TOKEN 时放行）
    if (p.startsWith('/api/') || p.startsWith('/stream/')) {
      if (!authed(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '访问密码错误' }));
        return;
      }
    }
    if (p === '/api/add' && req.method === 'POST') return handleAdd(req, res);
    if (p === '/api/status') return handleStatus(res);
    if (p === '/api/remove') return handleRemove(req, res, url);
    if (p === '/api/pause') return handlePauseResume(req, res, url, 'pause');
    if (p === '/api/resume') return handlePauseResume(req, res, url, 'resume');
    if (p === '/api/select') return handleSelect(req, res, url);
    if (p === '/api/webdav-upload' && req.method === 'POST') return handleWebdavUpload(req, res);
    if (p.startsWith('/stream/')) return handleStream(req, res, url);
    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    console.error('[服务器错误]', e.message);
    if (!res.headersSent) { res.writeHead(500); res.end('Server Error'); }
    else { try { res.destroy(); } catch (e2) {} }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  writeLog('==============================================');
  writeLog('  磁力影院 · 私有云盘服务已启动');
  writeLog('  本机访问: http://localhost:' + PORT);
  writeLog('  手机/局域网访问: http://本机IP:' + PORT + (TOKEN ? ('  密码: ' + TOKEN) : ''));
  writeLog('  下载目录: ' + TORRENT_DIR);
  writeLog('  ' + (TOKEN ? '访问密码已开启' : '警告：未设置 TOKEN 访问密码，任何人都能访问你的云盘！'));
  writeLog('==============================================');
});

process.on('SIGINT', () => {
  console.log('\n正在停止服务...');
  client.destroy(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});
