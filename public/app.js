/**
 * FlareHub frontend panel logic.
 * - Link converter: transforms upstream URLs to proxied URLs
 * - Access rules display (chips)
 * - Usage examples
 */

(function () {
  'use strict';

  var THEME_KEY = 'flarehub-theme';

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
    'gitlab.com',
  ];

  /** Usage examples for the panel. */
  var EXAMPLES = [
    { label: 'GitHub Release', url: 'https://github.com/user/repo/releases/download/v1.0/file.zip' },
    { label: 'GitHub Archive', url: 'https://github.com/user/repo/archive/refs/tags/v1.0.tar.gz' },
    { label: 'GitHub Raw', url: 'https://raw.githubusercontent.com/user/repo/main/README.md' },
    { label: 'GitHub Blob', url: 'https://github.com/user/repo/blob/main/README.md' },
    { label: 'GitHub Codeload', url: 'https://codeload.github.com/user/repo/zip/refs/heads/main' },
    { label: 'Hugging Face', url: 'https://huggingface.co/bert-base-uncased/resolve/main/pytorch_model.bin' },
    { label: 'Docker Hub', cmd: 'docker pull your-domain.com/nginx' },
    { label: 'GHCR', cmd: 'docker pull your-domain.com/ghcr.io/user/image' },
    { label: 'Docker Binary', url: 'https://download.docker.com/linux/static/stable/x86_64/docker.tgz' },
    { label: 'GitLab Blob', url: 'https://gitlab.com/user/repo/-/blob/main/README.md' },
    { label: 'GitLab Raw', url: 'https://gitlab.com/user/repo/-/raw/main/README.md' },
    { label: 'GitLab Archive', url: 'https://gitlab.com/user/repo/-/archive/main/repo.tar.gz' },
  ];

  /**
   * Convert an upstream URL to a proxied URL.
   * "blob" pages are auto-converted to their raw equivalent so the proxied
   * link returns the file content instead of the HTML view:
   *   GitHub: github.com/{owner}/{repo}/blob/{ref}/{path}
   *           -> raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
   *   GitLab: gitlab.com/{group}/{repo}/-/blob/{ref}/{path}
   *           -> gitlab.com/{group}/{repo}/-/raw/{ref}/{path}
   * @param {string} input - Original URL
   * @returns {string|null} Proxied URL or null if unrecognized
   */
  function convertUrl(input) {
    input = (input || '').trim();
    if (!input) return null;

    try {
      var u = new URL(input);
      if (HOSTS.indexOf(u.hostname) === -1) return null;

      var host = u.hostname;
      var path = u.pathname;

      // GitHub blob page -> raw host (drop the "/blob" segment).
      if (host === 'github.com') {
        var blobMatch = path.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
        if (blobMatch) {
          host = 'raw.githubusercontent.com';
          path = '/' + blobMatch[1] + '/' + blobMatch[2] + '/' + blobMatch[3];
        }
      }

      // GitLab blob page -> /-/raw/ on the same host (preserves subgroups).
      if (host === 'gitlab.com') {
        path = path.replace('/-/blob/', '/-/raw/');
      }

      // Primary format: origin/host/path (without protocol)
      return window.location.origin + '/' + host + path + u.search + u.hash;
    } catch (e) {
      return null;
    }
  }

  var toastTimer;

  /** Show a toast message. */
  function showToast(msg) {
    var toast = document.getElementById('toast');
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.classList.add('show');
    toastTimer = window.setTimeout(function () { toast.classList.remove('show'); }, 2000);
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
    var previewBtn = document.getElementById('previewButton');
    var themeToggle = document.getElementById('themeToggle');

    initThemeToggle(themeToggle);

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
        if (currentUrl) window.open(currentUrl, '_blank', 'noopener,noreferrer');
      });
    }

    // Preview button — opens the proxied URL in a new window with ?preview=1.
    // The backend serves it as inline text/plain (HTML forced to text/plain to
    // prevent rendering), so there is zero phishing risk.
    if (previewBtn) {
      previewBtn.addEventListener('click', function () {
        if (currentUrl) {
          var sep = currentUrl.indexOf('?') === -1 ? '?' : '&';
          window.open(currentUrl + sep + 'preview=1', '_blank', 'noopener,noreferrer');
        }
      });
    }

    // Render access rules
    renderRules();
    renderExamples();
    initGlassMotion();
  });

  /**
   * Initialize and persist the theme toggle.
   * Three modes: auto (follow system), light, dark.
   * Clicking in auto mode switches to the opposite of the current system
   * preference (guarantees a visible change); clicking in an explicit mode
   * returns to auto.
   */
  function initThemeToggle(button) {
    if (!button) return;
    var root = document.documentElement;
    var systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

    function currentMode() {
      var t = root.getAttribute('data-theme');
      return t === 'light' || t === 'dark' ? t : 'auto';
    }

    function updateButton() {
      var labels = {
        auto: '自动（跟随系统）',
        light: '亮色模式',
        dark: '深色模式'
      };
      var mode = currentMode();
      button.setAttribute('aria-label', labels[mode]);
      button.setAttribute('title', labels[mode]);
    }

    /**
     * Temporarily disable all transitions while a theme change applies, so the
     * semi-transparent borders/shadows on cards don't animate (which flashes on
     * iOS Safari). The class is removed on the next animation frame.
     */
    function suppressTransitionWhile(applyChange) {
      root.classList.add('theme-switching');
      applyChange();
      // Force a synchronous reflow so the new values commit while transitions
      // are disabled, then restore transitions after the next paint.
      void root.offsetHeight;
      window.requestAnimationFrame(function () {
        root.classList.remove('theme-switching');
      });
    }

    button.addEventListener('click', function () {
      var current = currentMode();
      // In auto mode, switch to the opposite of the system preference so the
      // change is always visible. In an explicit mode, return to auto.
      var next = current === 'auto'
        ? (systemTheme.matches ? 'light' : 'dark')
        : 'auto';
      suppressTransitionWhile(function () {
        root.setAttribute('data-theme', next);
      });
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch (e) {
        // The selected theme still applies for the current page.
      }
      updateButton();
    });

    if (systemTheme.addEventListener) {
      systemTheme.addEventListener('change', function () {
        updateButton();
      });
    }
    updateButton();
  }

  /**
   * Track pointer position for a lightweight glass highlight.
   */
  function initGlassMotion() {
    if (!window.matchMedia('(pointer: fine)').matches ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    document.querySelectorAll('.card-glass').forEach(function (card) {
      var frame = 0;
      var rect = null;
      var point = { x: 0, y: 0 };

      card.addEventListener('pointerenter', function () {
        rect = card.getBoundingClientRect();
      }, { passive: true });

      card.addEventListener('pointermove', function (event) {
        point.x = event.clientX;
        point.y = event.clientY;
        if (frame || !rect) return;
        frame = window.requestAnimationFrame(function () {
          var x = ((point.x - rect.left) / rect.width) * 100;
          var y = ((point.y - rect.top) / rect.height) * 100;
          card.style.setProperty('--glass-x', x.toFixed(1) + '%');
          card.style.setProperty('--glass-y', y.toFixed(1) + '%');
          frame = 0;
        });
      }, { passive: true });

      card.addEventListener('pointerleave', function () {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        rect = null;
        card.style.removeProperty('--glass-x');
        card.style.removeProperty('--glass-y');
      }, { passive: true });
    });
  }

  /**
   * Render access rules as chips.
   */
  function renderRules() {
    var wlEl = document.getElementById('whitelistChips');
    var blEl = document.getElementById('blacklistChips');
    var modeEl = document.getElementById('policyMatchMode');
    if (!wlEl || !blEl) return;

    var config = { whitelist: [], blacklist: [], caseInsensitive: false };
    var configElement = document.getElementById('flarehub-config');
    if (configElement) {
      try {
        config = JSON.parse(configElement.textContent);
      } catch (_) {
        // Keep safe defaults when deployment configuration is malformed.
      }
    }
    renderChips(wlEl, config.whitelist);
    renderChips(blEl, config.blacklist);
    if (modeEl) {
      modeEl.textContent = config.caseInsensitive
        ? '关键词包含匹配，忽略大小写'
        : '关键词包含匹配，区分大小写';
    }
  }

  function renderChips(el, items) {
    var fragment = document.createDocumentFragment();
    var values = items && items.length ? items : ['无'];

    values.forEach(function (item) {
      var code = document.createElement('code');
      code.textContent = item;
      if (!items || !items.length) code.className = 'muted';
      fragment.appendChild(code);
    });
    el.replaceChildren(fragment);
  }

  /**
   * Render usage examples.
   */
  function renderExamples() {
    var container = document.getElementById('usageExamples');
    if (!container) return;

    var fragment = document.createDocumentFragment();

    EXAMPLES.forEach(function (ex) {
      var example = document.createElement('div');
      var label = document.createElement('strong');
      var value = document.createElement('code');

      example.className = 'example';
      label.textContent = ex.label;
      if (ex.url) {
        // Reuse the same conversion logic (e.g. blob -> raw) for consistency.
        value.textContent = convertUrl(ex.url) || ex.url;
      } else {
        value.textContent = ex.cmd.replace('your-domain.com', window.location.host);
      }

      example.append(label, value);
      fragment.appendChild(example);
    });

    container.replaceChildren(fragment);
  }
})();
