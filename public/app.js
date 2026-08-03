/**
 * FlareHub frontend panel logic.
 * - Link converter: transforms upstream URLs to proxied URLs
 * - Access rules display (chips)
 * - Usage examples
 */

(function () {
  'use strict';

  /** Upstream hosts that can be proxied. */
  var HOSTS = [
    'github.com',
    'raw.githubusercontent.com',
    'api.github.com',
    'codeload.github.com',
    'github.githubassets.com',
    'gist.github.com',
    'gist.githubusercontent.com',
    'objects.githubusercontent.com',
    'github-releases.githubusercontent.com',
    'huggingface.co',
    'cdn-lfs.hf.co',
    'cdn-lfs-us-1.hf.co',
    'download.docker.com',
    'ghcr.io',
    'quay.io',
    'gcr.io',
    'registry.k8s.io',
  ];

  /** Usage examples for the panel. */
  var EXAMPLES = [
    { label: 'GitHub Release', url: 'https://github.com/user/repo/releases/download/v1.0/file.zip' },
    { label: 'GitHub Archive', url: 'https://github.com/user/repo/archive/refs/tags/v1.0.tar.gz' },
    { label: 'GitHub Raw', url: 'https://raw.githubusercontent.com/user/repo/main/README.md' },
    { label: 'GitHub Codeload', url: 'https://codeload.github.com/user/repo/zip/refs/heads/main' },
    { label: 'Hugging Face', url: 'https://huggingface.co/bert-base-uncased/resolve/main/pytorch_model.bin' },
    { label: 'Docker Hub', cmd: 'docker pull your-domain.com/nginx' },
    { label: 'GHCR', cmd: 'docker pull your-domain.com/ghcr.io/user/image' },
    { label: 'Docker Binary', url: 'https://download.docker.com/linux/static/stable/x86_64/docker.tgz' },
  ];

  /**
   * Convert an upstream URL to a proxied URL.
   * @param {string} input - Original URL
   * @returns {string|null} Proxied URL or null if unrecognized
   */
  function convertUrl(input) {
    input = (input || '').trim();
    if (!input) return null;

    try {
      var u = new URL(input);
      if (HOSTS.indexOf(u.hostname) === -1) return null;
      // Primary format: origin/host/path (without protocol)
      return window.location.origin + '/' + u.hostname + u.pathname + u.search + u.hash;
    } catch (e) {
      return null;
    }
  }

  /**
   * Escape HTML special characters.
   */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Show a toast message.
   */
  function showToast(msg) {
    var toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 2000);
  }

  /**
   * Copy text to clipboard with graceful fallback for non-secure contexts.
   */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () {
        showToast('已复制');
      }).catch(function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  /**
   * Fallback copy using a temporary textarea + execCommand.
   */
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(ok ? '已复制' : '复制失败');
    } catch (e) {
      showToast('复制失败');
    }
  }

  // DOM Ready
  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('proxyForm');
    var input = document.getElementById('githubLinkInput');
    var convertBtn = document.getElementById('pasteConvertButton');
    var output = document.getElementById('githubOutput');
    var outputLink = document.getElementById('githubFormattedLink');
    var copyBtn = document.getElementById('copyButton');
    var downloadBtn = document.getElementById('downloadButton');

    var currentUrl = null;

    function doConvert(rawInput) {
      var text = (rawInput !== undefined ? rawInput : input.value).trim();
      if (!text) {
        showToast('请输入链接');
        return;
      }

      var proxied = convertUrl(text);
      if (!proxied) {
        showToast('无法识别的链接');
        return;
      }

      currentUrl = proxied;
      outputLink.textContent = proxied;
      output.classList.remove('hidden');
    }

    // Paste and convert
    if (convertBtn) {
      convertBtn.addEventListener('click', function () {
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.readText().then(function (text) {
            input.value = text;
            doConvert(text);
          }).catch(function () {
            input.focus();
            doConvert();
          });
        } else {
          input.focus();
          doConvert();
        }
      });
    }

    // Enter key in input
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          doConvert();
        }
      });
    }

    // Form submit
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        doConvert();
      });
    }

    // Copy button
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (currentUrl) copyText(currentUrl);
      });
    }

    // Download button
    if (downloadBtn) {
      downloadBtn.addEventListener('click', function () {
        if (currentUrl) window.open(currentUrl, '_blank');
      });
    }

    // Render access rules
    renderRules();
    renderExamples();
  });

  /**
   * Render access rules as chips.
   */
  function renderRules() {
    var wlEl = document.getElementById('whitelistChips');
    var blEl = document.getElementById('blacklistChips');
    var modeEl = document.getElementById('policyMatchMode');
    if (!wlEl || !blEl) return;

    var config = window.__FLAREHUB_CONFIG__ || { whitelist: [], blacklist: [], caseInsensitive: false };
    renderChips(wlEl, config.whitelist);
    renderChips(blEl, config.blacklist);
    if (modeEl) {
      modeEl.textContent = config.caseInsensitive
        ? '关键词包含匹配，忽略大小写'
        : '关键词包含匹配，区分大小写';
    }
  }

  function renderChips(el, items) {
    if (!items || items.length === 0) {
      el.innerHTML = '<code class="muted">无</code>';
      return;
    }
    el.innerHTML = items.map(function (item) {
      return '<code>' + escapeHtml(item) + '</code>';
    }).join('');
  }

  /**
   * Render usage examples.
   */
  function renderExamples() {
    var container = document.getElementById('usageExamples');
    if (!container) return;

    var origin = window.location.origin;
    var html = EXAMPLES.map(function (ex) {
      if (ex.url) {
        var u = new URL(ex.url);
        var proxied = origin + '/' + u.hostname + u.pathname + u.search;
        return '<div class="example">' +
          '<strong>' + escapeHtml(ex.label) + '</strong>' +
          '<code>' + escapeHtml(proxied) + '</code>' +
          '</div>';
      } else {
        var cmd = ex.cmd.replace('your-domain.com', origin.replace(/^https?:\/\//, ''));
        return '<div class="example">' +
          '<strong>' + escapeHtml(ex.label) + '</strong>' +
          '<code>' + escapeHtml(cmd) + '</code>' +
          '</div>';
      }
    }).join('');

    container.innerHTML = html;
  }
})();
