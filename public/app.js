/* 磁力影院前端逻辑 */
(function () {
  var taskList = document.getElementById('taskList');
  var playerBox = document.getElementById('playerBox');
  var video = document.getElementById('videoPlayer');
  var toast = document.getElementById('toast');
  var pollTimer = null;
  var currentTorrents = {}; // infoHash -> state
  var fileChecks = {}; // 'hash:index' -> 是否勾选（true=下载该文件）。轮询重渲染时保持用户选择
  // 云盘访问令牌：从 URL ?t= 读取（云端模式），本地模式为空
  var authToken = (function () {
    try {
      var m = location.search.match(/[?&]t=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  })();
  // 统一请求：云端模式自动带访问令牌
  function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (authToken) opts.headers['X-Auth-Token'] = authToken;
    return fetch(url, opts);
  }
  // 从本地存储恢复勾选状态（页面意外重载/返回导航后不丢）
  try {
    var savedChecks = localStorage.getItem('magnetFileChecks');
    if (savedChecks) fileChecks = JSON.parse(savedChecks) || {};
  } catch (e) {}

  // 暴露给原生：全屏时按返回键=退出全屏（返回 true 表示已处理）
  window.__exitFs = function () {
    if (playerBox.classList.contains('fs')) {
      toggleFullscreen();
      return true;
    }
    return false;
  };

  function fmtSize(b) {
    if (!b && b !== 0) return '-';
    if (b === 0) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(b) / Math.log(1024));
    if (i >= u.length) i = u.length - 1;
    return (b / Math.pow(1024, i)).toFixed(i >= 2 ? 2 : 0) + ' ' + u[i];
  }
  function fmtSpeed(v) { return fmtSize(v || 0) + '/s'; }
  function fmtPct(p) { return (p * 100).toFixed(1) + '%'; }
  function setToast(msg, cls) {
    toast.textContent = msg || '';
    toast.className = 'status-msg' + (cls ? ' ' + cls : '');
  }

  function parseMagnet(raw) {
    raw = (raw || '').trim();
    if (!raw) return null;
    if (raw.indexOf('magnet:') === 0) return raw;
    if (/^[a-fA-F0-9]{40}$/.test(raw)) return 'magnet:?xt=urn:btih:' + raw.toLowerCase();
    if (/^[a-fA-F0-9]{32}$/.test(raw)) return 'magnet:?xt=urn:btih:' + raw.toLowerCase();
    return null;
  }

  function addTask() {
    var raw = document.getElementById('magnetInput').value;
    var magnet = parseMagnet(raw);
    if (!magnet) { setToast('磁力链接格式不正确，请检查后重试', 'err'); return; }
    // 不锁定按钮：允许随时添加其他磁力，多个任务并行下载
    setToast('正在添加任务...', '');
    tryAdd(magnet, 0);
  }

  // 带自动重试的添加：失败后 6 秒自动重试，最多 3 次
  function tryAdd(magnet, attempt) {
    apiFetch('/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet: magnet })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        setToast(d.duplicated ? '该磁力已在任务列表中' : ('任务已添加：' + (d.name || d.infoHash)), d.duplicated ? 'ok' : 'ok');
        document.getElementById('magnetInput').value = '';
        pollStatus();
      } else if (attempt < 2) {
        setToast('连接节点中（第 ' + (attempt + 1) + ' 次）...6 秒后自动重试', '');
        setTimeout(function () { tryAdd(magnet, attempt + 1); }, 6000);
      } else {
        setToast('添加失败：' + d.error, 'err');
      }
    }).catch(function () {
      if (attempt < 2) {
        setTimeout(function () { tryAdd(magnet, attempt + 1); }, 3000);
      } else {
        setToast('无法连接服务端：请确认服务已启动', 'err');
      }
    });
  }

  function pollStatus() {
    apiFetch('/api/status').then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        currentTorrents = {};
        d.torrents.forEach(function (t) { currentTorrents[t.infoHash] = t; });
        renderTasks(d.torrents);
      }
    }).catch(function () {
      // 服务端未启动，静默
    });
  }

  function renderTasks(list) {
    if (!list.length) {
      taskList.innerHTML = '<div class="empty">还没有任务 · 粘贴磁力链接，点「添加任务」开始</div>';
      return;
    }
    // 清理已不存在任务的勾选记录（避免 localStorage 残留）
    var seen = {};
    list.forEach(function (t) {
      t.files.forEach(function (f) { seen[t.infoHash + ':' + f.index] = 1; });
    });
    Object.keys(fileChecks).forEach(function (k) { if (!seen[k]) delete fileChecks[k]; });
    try { localStorage.setItem('magnetFileChecks', JSON.stringify(fileChecks)); } catch (e) {}
    var html = '';
    list.forEach(function (t) {
      var badge = t.done ? '<span class="badge done">已完成</span>' :
        (t.paused ? '<span class="badge meta">已暂停</span>' :
          (t.progress > 0 ? '<span class="badge meta">下载中</span>' : '<span class="badge meta">连接中</span>'));
      var files = '';
      t.files.forEach(function (f) {
        var tag = f.video ? '<span class="fi-tag v">视频</span>' : (f.audio ? '<span class="fi-tag v">音频</span>' : '<span class="fi-tag o">文件</span>');
        var ck = fileChecks[t.infoHash + ':' + f.index];
        var checked = ck === undefined ? ' checked' : (ck ? ' checked' : '');
        var saveBtn = t.done && f.path ? '<button class="save-btn" data-rel="' + escapeAttr(f.path) + '">保存</button>' : '';
        files += '<div class="file-item' + (f.video ? ' video' : '') + '" data-hash="' + t.infoHash + '" data-idx="' + f.index + '" data-name="' + escapeAttr(f.name) + '">' +
          '<label class="file-check"><input type="checkbox" class="fchk" data-hash="' + t.infoHash + '" data-idx="' + f.index + '"' + checked + '><span class="cb"></span></label>' +
          '<span class="fi-name">' + escapeHtml(f.name) + '</span>' +
          '<span class="fi-size">' + fmtSize(f.length) + '</span>' + tag +
          saveBtn +
          '</div>';
      });
      html += '<div class="task" data-task="' + t.infoHash + '">' +
        '<div class="task-head"><div class="task-name">' + escapeHtml(t.name) + '</div>' + badge + '</div>' +
        '<div class="task-stats">' +
          '<div class="stat"><div class="v">' + fmtSize(t.length) + '</div><div class="k">总大小</div></div>' +
          '<div class="stat"><div class="v">' + fmtSpeed(t.downloadSpeed) + '</div><div class="k">下载速度</div></div>' +
          '<div class="stat"><div class="v">' + t.numPeers + ' 个</div><div class="k">连接节点</div></div>' +
          '<div class="stat"><div class="v">' + fmtPct(t.progress) + '</div><div class="k">进度</div></div>' +
        '</div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + (t.progress * 100) + '%"></div></div>' +
        files +
        '<div class="task-actions">' +
          (t.paused
            ? '<button class="resume-btn" data-resume="' + t.infoHash + '">继续下载</button>'
            : '<button class="pause-btn" data-pause="' + t.infoHash + '">暂停下载</button>') +
          '<button class="remove-btn" data-remove="' + t.infoHash + '">移除任务</button>' +
        '</div>' +
      '</div>';
    });
    taskList.innerHTML = html;

    // 绑定事件
    taskList.querySelectorAll('.file-item.video').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.closest('.fchk') || e.target.closest('.file-check')) return; // 勾选不触发播放
        playFile(el.getAttribute('data-hash'), parseInt(el.getAttribute('data-idx'), 10), el.getAttribute('data-name'));
      });
    });
    // 文件勾选：勾选=只下载该文件（自动停掉其他文件）；取消勾选=停止下载该文件
    taskList.querySelectorAll('.fchk').forEach(function (el) {
      el.addEventListener('change', function () {
        var want = el.checked ? 1 : 0;
        var key = el.getAttribute('data-hash') + ':' + el.getAttribute('data-idx');
        fileChecks[key] = el.checked;
        if (want) {
          // 只下载该文件：其他文件的勾选状态同步取消，界面与实际下载保持一致
          Object.keys(fileChecks).forEach(function (k) { if (k !== key) fileChecks[k] = false; });
        }
        try { localStorage.setItem('magnetFileChecks', JSON.stringify(fileChecks)); } catch (e) {}
        apiFetch('/api/select?hash=' + encodeURIComponent(el.getAttribute('data-hash')) + '&index=' + el.getAttribute('data-idx') + '&want=' + want)
          .then(function () {
            setToast(want ? '已选择：仅下载该文件' : '已停止下载该文件', 'ok');
            pollStatus();
          });
      });
    });
    taskList.querySelectorAll('.pause-btn').forEach(function (el) {
      el.addEventListener('click', function () {
        apiFetch('/api/pause?hash=' + encodeURIComponent(el.getAttribute('data-pause'))).then(function () { pollStatus(); });
      });
    });
    taskList.querySelectorAll('.resume-btn').forEach(function (el) {
      el.addEventListener('click', function () {
        apiFetch('/api/resume?hash=' + encodeURIComponent(el.getAttribute('data-resume'))).then(function () { pollStatus(); });
      });
    });
    // 保存已下载文件到手机公共下载目录
    taskList.querySelectorAll('.save-btn').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        if (window.android && window.android.saveFileToDownload) {
          var r = window.android.saveFileToDownload(el.getAttribute('data-rel'));
          setToast(r, r.indexOf('失败') >= 0 ? 'err' : 'ok');
        } else {
          setToast('当前环境不支持保存', 'err');
        }
      });
    });
    taskList.querySelectorAll('.remove-btn').forEach(function (el) {
      el.addEventListener('click', function () {
        apiFetch('/api/remove?hash=' + encodeURIComponent(el.getAttribute('data-remove'))).then(function () {
          pollStatus();
        });
      });
    });
  }

  function playFile(hash, idx, name) {
    playerBox.classList.add('show');
    document.getElementById('playingName').textContent = name || '播放中';
    setToast('正在缓冲视频数据…首次播放需等待下载，请稍候', '');
    video.src = '/stream/' + hash + '/' + idx;
    video.load();
    video.play().catch(function () {
      setToast('点击播放器上的播放按钮开始播放', '');
    });
  }

  // 视频流出错时的友好提示（不打断页面）
  video.addEventListener('error', function () {
    setToast('视频数据暂未就绪（正在下载对应片段），请稍候几秒后重试', 'err');
    video.removeAttribute('src');
    video.load();
    setTimeout(function () { setToast('', ''); }, 4000);
  });

  video.addEventListener('stalled', function () {
    setToast('网络较慢，正在缓冲…', '');
  });
  video.addEventListener('playing', function () {
    setToast('', '');
  });

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  document.getElementById('addBtn').addEventListener('click', addTask);
  document.getElementById('magnetInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addTask();
  });
  document.getElementById('closePlayer').addEventListener('click', function () {
    video.pause();
    video.removeAttribute('src');
    video.load();
    playerBox.classList.remove('show', 'fs');
    document.getElementById('videoFsBtn').textContent = '全屏';
  });

  // 全屏播放（CSS 全屏，不依赖 WebView 原生全屏 API）
  var fullscreenBtn = document.getElementById('videoFsBtn');
  function toggleFullscreen() {
    var isFs = playerBox.classList.toggle('fs');
    fullscreenBtn.textContent = isFs ? '退出全屏' : '全屏';
    if (isFs) {
      setToast('已全屏：旋转手机横屏观看效果最佳', 'ok');
    } else {
      setToast('', '');
    }
    return isFs;
  }
  fullscreenBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleFullscreen();
  });
  // 全屏模式下点画面任意处退出全屏
  video.addEventListener('click', function () {
    if (playerBox.classList.contains('fs')) {
      toggleFullscreen();
      playerBox.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // 连接我的云盘（云端模式）
  (function initCloudUI() {
    var tip = document.getElementById('cloudTip');
    function showTip(s, isErr) {
      if (tip) { tip.textContent = s; tip.style.color = isErr ? '#ff7a7a' : '#4cc38a'; }
    }
    // 已配置的云盘地址回填
    if (window.android && window.android.getCloudUrl) {
      var saved = window.android.getCloudUrl();
      if (saved) document.getElementById('cloudUrl').value = saved;
    }
    document.getElementById('cloudConnect').addEventListener('click', function () {
      var url = document.getElementById('cloudUrl').value.trim();
      var token = document.getElementById('cloudToken').value.trim();
      if (!url) { showTip('请填写云盘地址', true); return; }
      if (!/^https?:\/\//.test(url)) url = 'http://' + url;
      var full = token ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(token) : url;
      if (window.android && window.android.saveCloudUrl) {
        window.android.saveCloudUrl(url);
        showTip('正在连接云盘...');
        window.location.href = full; // 云端模式：页面从服务器加载
      } else {
        showTip('当前环境请直接浏览器打开：' + full);
      }
    });
    document.getElementById('cloudLocal').addEventListener('click', function () {
      if (window.android && window.android.saveCloudUrl) {
        window.android.saveCloudUrl('');
        showTip('已切换回本地模式，重启 App 生效', '');
      }
    });
  })();

  // 启动轮询
  pollStatus();
  pollTimer = setInterval(pollStatus, 2500);
})();
