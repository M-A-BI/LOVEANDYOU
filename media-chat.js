/**
 * 语音/视频聊天增强模块
 * - 语音按钮录音/发送，聊天框长按录音
 * - 图片按钮支持图片/音频/视频
 * - 自定义回复库增加语音库/视频库
 * - 语音可播放/停止，视频可直接播放
 * - 关闭按钮兜底修复
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'zcardMediaLibraryV1';
    const STORAGE_META_KEY = 'zcardMediaLibraryMetaV1';
    const MAX_MEDIA_SIZE = 30 * 1024 * 1024;
    let mediaLibrary = loadMediaLibrary();
    let mediaLibraryLoaded = false;
    let recorder = null;
    let recorderStream = null;
    let chunks = [];
    let recordingStart = 0;
    let recordingTimer = null;
    let longPressTimer = null;
    let isRecording = false;
    let pendingRecording = null;
    let currentAudio = null;
    let currentAudioBubble = null;
    let currentVideoObjectUrl = '';
    const VIDEO_BUBBLE_WIDTH_KEY = 'chat_video_bubble_width';
    const VIDEO_BUBBLE_HEIGHT_KEY = 'chat_video_bubble_height';

    function notify(text, type = 'info') {
        if (typeof showNotification === 'function') showNotification(text, type);
    }

    function normalizeUrl(value) {
        let url = String(value || '').trim();
        if (!url) return '';
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
        try {
            const parsed = new URL(url);
            if (!/^https?:$/i.test(parsed.protocol)) return '';
            return parsed.href;
        } catch (e) {
            return '';
        }
    }

    function getUrlHost(url) {
        try { return new URL(url).hostname.replace(/^www\./, '') || '网页链接'; } catch (e) { return '网页链接'; }
    }

    function clampVideoSize(value, fallback, min, max) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, Math.round(n)));
    }

    function applyVideoBubbleSize(width, height) {
        const w = clampVideoSize(width, 168, 120, 260);
        const h = clampVideoSize(height, Math.round(w * 2 / 3), 80, 220);
        document.documentElement.style.setProperty('--chat-video-bubble-width', w + 'px');
        document.documentElement.style.setProperty('--chat-video-bubble-height', h + 'px');
        return { width: w, height: h };
    }

    function initVideoBubbleSize() {
        const width = localStorage.getItem(VIDEO_BUBBLE_WIDTH_KEY) || 168;
        const height = localStorage.getItem(VIDEO_BUBBLE_HEIGHT_KEY) || 112;
        applyVideoBubbleSize(width, height);
    }

    window.setChatVideoBubbleSize = function(width, height) {
        const size = applyVideoBubbleSize(width, height);
        localStorage.setItem(VIDEO_BUBBLE_WIDTH_KEY, String(size.width));
        localStorage.setItem(VIDEO_BUBBLE_HEIGHT_KEY, String(size.height));
        notify('视频气泡大小已更新', 'success');
        return size;
    };

    function applyPageFit() {
        const inputWrapper = document.querySelector('.input-area-wrapper');
        const header = document.querySelector('.header');
        const root = document.documentElement;
        const inputHeight = inputWrapper ? Math.ceil(inputWrapper.getBoundingClientRect().height) : 64;
        const headerHeight = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
        const viewportHeight = Math.floor((window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0);
        root.style.setProperty('--chat-input-height', inputHeight + 'px');
        root.style.setProperty('--chat-header-height', headerHeight + 'px');
        root.style.setProperty('--app-viewport-height', viewportHeight + 'px');
        const chatArea = document.querySelector('.main-chat-area');
        if (chatArea) {
            chatArea.style.paddingBottom = inputHeight + 'px';
            chatArea.style.height = Math.max(0, viewportHeight - headerHeight) + 'px';
        }
        document.documentElement.style.height = viewportHeight + 'px';
        document.body.style.height = viewportHeight + 'px';
    }

    function initPageFit() {
        applyPageFit();
        window.addEventListener('resize', applyPageFit, { passive: true });
        window.addEventListener('orientationchange', () => setTimeout(applyPageFit, 120), { passive: true });
        if (window.visualViewport) window.visualViewport.addEventListener('resize', applyPageFit, { passive: true });
        if (window.ResizeObserver) {
            const observer = new ResizeObserver(applyPageFit);
            const inputWrapper = document.querySelector('.input-area-wrapper');
            const header = document.querySelector('.header');
            if (inputWrapper) observer.observe(inputWrapper);
            if (header) observer.observe(header);
        }
        setTimeout(applyPageFit, 100);
        setTimeout(applyPageFit, 500);
    }

    function normalizeLibrary(value) {
        return {
            voice: Array.isArray(value && value.voice) ? value.voice : [],
            video: Array.isArray(value && value.video) ? value.video : []
        };
    }

    function loadMediaLibrary() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return normalizeLibrary(saved);
        } catch (e) {
            return { voice: [], video: [] };
        }
    }

    async function loadMediaLibraryAsync() {
        try {
            if (typeof localforage !== 'undefined') {
                const saved = await localforage.getItem(STORAGE_KEY);
                if (saved && (Array.isArray(saved.voice) || Array.isArray(saved.video))) {
                    mediaLibrary = normalizeLibrary(saved);
                    mediaLibraryLoaded = true;
                    renderMediaLibrary('voice');
                    renderMediaLibrary('video');
                    return;
                }
            }
        } catch (e) {
            console.warn('读取媒体库失败，改用 localStorage 兜底:', e);
        }
        mediaLibrary = loadMediaLibrary();
        mediaLibraryLoaded = true;
        renderMediaLibrary('voice');
        renderMediaLibrary('video');
    }

    async function saveMediaLibrary() {
        try {
            if (typeof localforage !== 'undefined') {
                await localforage.setItem(STORAGE_KEY, mediaLibrary);
                const meta = {
                    voice: mediaLibrary.voice.map(item => ({ id: item.id, name: item.name, source: item.source, savedAt: item.savedAt || Date.now() })),
                    video: mediaLibrary.video.map(item => ({ id: item.id, name: item.name, source: item.source, savedAt: item.savedAt || Date.now() }))
                };
                localStorage.setItem(STORAGE_META_KEY, JSON.stringify(meta));
                return true;
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(mediaLibrary));
            return true;
        } catch (e) {
            console.error('媒体库保存失败:', e);
            notify('媒体库保存失败，文件可能过大或存储空间不足', 'error');
            return false;
        }
    }

    window.getZCardMediaLibrary = function () {
        return {
            voice: Array.isArray(mediaLibrary.voice) ? mediaLibrary.voice.slice() : [],
            video: Array.isArray(mediaLibrary.video) ? mediaLibrary.video.slice() : [],
            loaded: !!mediaLibraryLoaded
        };
    };

    function getProbability(key, fallback = 0) {
        const raw = (typeof settings !== 'undefined' && settings) ? settings[key] : localStorage.getItem(key);
        const n = Number(raw);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0, Math.min(100, n));
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, s => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[s]));
    }

    function fileToDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function dataUrlToObjectUrl(dataUrl) {
        if (!/^data:(audio|video)\//i.test(dataUrl || '')) return dataUrl;
        try {
            const parts = dataUrl.split(',');
            if (parts.length < 2) return dataUrl;
            const header = parts[0];
            const mimeMatch = header.match(/^data:([^;]+)/i);
            const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
            const binary = atob(parts.slice(1).join(','));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return URL.createObjectURL(new Blob([bytes], { type: mime }));
        } catch (e) {
            console.warn('媒体 dataURL 转 Blob 失败，回退原地址:', e);
            return dataUrl;
        }
    }

    function addMediaMessage({ sender = 'user', kind = 'audio', url, name = '', text = '' }) {
        if (!url) return;
        const msg = {
            id: Date.now() + Math.floor(Math.random() * 999),
            sender,
            text: text || '',
            timestamp: new Date(),
            image: null,
            status: sender === 'user' ? 'sent' : undefined,
            favorited: false,
            note: null,
            replyTo: typeof currentReplyTo !== 'undefined' ? currentReplyTo : null,
            type: kind === 'video' ? 'video' : 'voice',
            mediaKind: kind,
            mediaUrl: url,
            mediaName: name || (kind === 'video' ? '视频消息' : '语音消息')
        };
        if (kind === 'audio') msg.voiceUrl = url;
        if (kind === 'video') msg.videoUrl = url;

        if (typeof addMessage === 'function') addMessage(msg);
        if (sender === 'user' && typeof playSound === 'function') playSound('send');
        if (sender !== 'user' && typeof playSound === 'function') playSound('receive');
        if (typeof currentReplyTo !== 'undefined') {
            currentReplyTo = null;
            if (typeof updateReplyPreview === 'function') updateReplyPreview();
        }
        if (typeof throttledSaveData === 'function') throttledSaveData();

        if (sender === 'user' && typeof simulateReply === 'function' && typeof isBatchMode !== 'undefined' && !isBatchMode) {
            setTimeout(() => simulateReply(), 1000 + Math.random() * 1800);
        }
    }

    function addLinkMessage(url, sender = 'user', title = '') {
        const normalized = normalizeUrl(url);
        if (!normalized) {
            notify('链接格式不正确，请输入网页或应用分享链接', 'warning');
            return false;
        }
        const host = getUrlHost(normalized);
        const linkTitle = String(title || '').trim() || (host.indexOf('xiaohongshu') >= 0 || host.indexOf('xhslink') >= 0 ? '小红书链接' : host || '网页链接');
        const msg = {
            id: Date.now() + Math.floor(Math.random() * 999),
            sender,
            text: '',
            timestamp: new Date(),
            image: null,
            status: sender === 'user' ? 'sent' : undefined,
            favorited: false,
            note: null,
            replyTo: typeof currentReplyTo !== 'undefined' ? currentReplyTo : null,
            type: 'link',
            linkUrl: normalized,
            linkTitle,
            linkDesc: host
        };
        if (typeof addMessage === 'function') addMessage(msg);
        if (sender === 'user' && typeof playSound === 'function') playSound('send');
        if (typeof currentReplyTo !== 'undefined') {
            currentReplyTo = null;
            if (typeof updateReplyPreview === 'function') updateReplyPreview();
        }
        if (typeof throttledSaveData === 'function') throttledSaveData();
        if (sender === 'user' && typeof simulateReply === 'function' && typeof isBatchMode !== 'undefined' && !isBatchMode) {
            setTimeout(() => simulateReply(), 1000 + Math.random() * 1800);
        }
        return true;
    }

    window.sendChatLinkCard = function(url, title) {
        return addLinkMessage(url, 'user', title);
    };

    function getSelectedFileKind(file) {
        const type = String(file && file.type || '').toLowerCase();
        const name = String(file && file.name || '').toLowerCase();
        if (type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|webm|flac)$/i.test(name)) return 'audio';
        if (type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i.test(name)) return 'video';
        if (type.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|heic|heif)$/i.test(name)) return 'image';
        return '';
    }

    function guessMediaMime(file, kind) {
        const type = String(file && file.type || '').toLowerCase();
        const name = String(file && file.name || '').toLowerCase();
        if (type.startsWith(kind + '/')) return type;
        if (kind === 'audio') {
            if (/\.mp3$/i.test(name)) return 'audio/mpeg';
            if (/\.wav$/i.test(name)) return 'audio/wav';
            if (/\.(m4a|aac)$/i.test(name)) return 'audio/mp4';
            if (/\.(ogg|oga)$/i.test(name)) return 'audio/ogg';
            if (/\.flac$/i.test(name)) return 'audio/flac';
            if (/\.webm$/i.test(name)) return 'audio/webm';
            return 'audio/mpeg';
        }
        if (kind === 'video') {
            if (/\.(mov|m4v)$/i.test(name)) return 'video/mp4';
            if (/\.webm$/i.test(name)) return 'video/webm';
            return 'video/mp4';
        }
        return type || 'application/octet-stream';
    }

    window.sendChatMediaFile = async function (file, sender = 'user', caption = '') {
        if (!file) return;
        const kind = getSelectedFileKind(file);
        const isAudio = kind === 'audio';
        const isVideo = kind === 'video';
        if (!isAudio && !isVideo) return;
        if (file.size > MAX_MEDIA_SIZE) {
            notify('音频/视频不能超过 30MB', 'warning');
            return;
        }
        try {
            notify('正在读取媒体文件...', 'info');
            const fixedBlob = file.type ? file : new Blob([file], { type: guessMediaMime(file, isVideo ? 'video' : 'audio') });
            const url = await fileToDataURL(fixedBlob);
            addMediaMessage({
                sender,
                kind: isVideo ? 'video' : 'audio',
                url,
                name: file.name,
                text: caption
            });
        } catch (e) {
            notify('媒体文件读取失败', 'error');
        }
    };

    window.tryPartnerAutoMediaReply = function () {
        if (!mediaLibraryLoaded) return false;
        const voiceChance = getProbability('partnerVoiceChance', 0);
        const videoChance = getProbability('partnerVideoChance', 0);
        const roll = Math.random() * 100;
        let kind = null;
        if (mediaLibrary.voice.length && roll < voiceChance) {
            kind = 'voice';
        } else if (mediaLibrary.video.length && roll < voiceChance + videoChance) {
            kind = 'video';
        }
        if (!kind) return false;
        const item = mediaLibrary[kind][Math.floor(Math.random() * mediaLibrary[kind].length)];
        if (!item) return false;
        addMediaMessage({
            sender: 'partner',
            kind: kind === 'video' ? 'video' : 'audio',
            url: item.url,
            name: item.name
        });
        if (typeof window._sendPartnerNotification === 'function') {
            window._sendPartnerNotification((typeof settings !== 'undefined' && settings.partnerName) || '对方', kind === 'video' ? '[视频]' : '[语音]');
        }
        return true;
    };

    // 长按聊天输入框录音
    function initLongPressVoice() {
        const input = document.getElementById('message-input');
        if (!input || input.dataset.voiceHoldReady) return;
        input.dataset.voiceHoldReady = '1';

        input.addEventListener('pointerdown', e => {
            if (e.button !== undefined && e.button !== 0) return;
            clearTimeout(longPressTimer);
            longPressTimer = setTimeout(() => {
                startRecording();
            }, 520);
        });

        input.addEventListener('pointerup', () => {
            clearTimeout(longPressTimer);
            if (isRecording) stopRecording();
        });
        input.addEventListener('pointercancel', () => {
            clearTimeout(longPressTimer);
            if (isRecording) cancelRecording();
        });
        input.addEventListener('pointerleave', () => {
            clearTimeout(longPressTimer);
        });
        input.addEventListener('contextmenu', e => {
            if (isRecording) e.preventDefault();
        });
    }

    function initVoiceSendButton() {
        const btn = document.getElementById('batch-btn');
        if (!btn || btn.dataset.voiceButtonReady) return;
        btn.dataset.voiceButtonReady = '1';
        btn.dataset.voiceButton = '1';
        btn.title = '语音';
        btn.classList.remove('batch-btn');
        btn.classList.add('voice-input-btn');
        btn.innerHTML = '<i class="fas fa-microphone"></i>';
        const clone = btn.cloneNode(true);
        btn.parentNode.replaceChild(clone, btn);
        try {
            if (typeof DOMElements !== 'undefined' && DOMElements) DOMElements.batchBtn = clone;
        } catch (e) {}
        clone.addEventListener('click', async e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (pendingRecording) {
                await sendPendingRecording();
                return;
            }
            if (isRecording) {
                stopRecording();
                return;
            }
            startRecording();
        }, true);

        const extraBtn = document.getElementById('batch-btn-extra');
        if (extraBtn) {
            extraBtn.title = '语音';
            extraBtn.dataset.voiceButton = '1';
            extraBtn.innerHTML = '<i class="fas fa-microphone"></i>';
            const extraClone = extraBtn.cloneNode(true);
            extraBtn.parentNode.replaceChild(extraClone, extraBtn);
            extraClone.addEventListener('click', e => {
                e.preventDefault();
                e.stopImmediatePropagation();
                clone.click();
            }, true);
        }
    }

    function initMediaAttachmentInput() {
        const input = document.getElementById('image-input');
        if (!input || input.dataset.mediaInputReady) return;
        input.dataset.mediaInputReady = '1';
        // 不设置 accept，强制走系统文件选择器，不限制为相册。
        input.removeAttribute('accept');
        input.addEventListener('change', e => {
            const file = input.files && input.files[0];
            if (!file) return;
            const kind = getSelectedFileKind(file);
            if (kind === 'audio' || kind === 'video') {
                e.preventDefault();
                e.stopImmediatePropagation();
                window.sendChatMediaFile(file, 'user');
                input.value = '';
                return;
            }
            if (kind !== 'image') {
                e.preventDefault();
                e.stopImmediatePropagation();
                notify('请选择图片、音频或视频文件', 'warning');
                input.value = '';
            }
        }, true);
    }

    function closeAttachMenu() {
        const menu = document.getElementById('chat-attach-menu');
        if (menu) menu.remove();
    }

    function promptLinkAndSend() {
        closeAttachMenu();
        const url = prompt('粘贴网页、小红书或其他应用分享链接：');
        if (url === null) return;
        const normalized = normalizeUrl(url);
        if (!normalized) {
            notify('链接格式不正确，请输入网页或应用分享链接', 'warning');
            return;
        }
        const defaultName = getUrlHost(normalized);
        const title = prompt('编辑链接卡片名称：', defaultName) || defaultName;
        addLinkMessage(normalized, 'user', title);
    }

    function openAttachFilePicker() {
        closeAttachMenu();
        const input = document.getElementById('image-input');
        if (input) {
            input.removeAttribute('accept');
            input.value = '';
            input.click();
        }
    }

    window.toggleChatAttachMenu = function(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        }
        const existing = document.getElementById('chat-attach-menu');
        if (existing) {
            existing.remove();
            return false;
        }
        const btn = (event && event.currentTarget) || document.getElementById('attachment-btn');
        const menu = document.createElement('div');
        menu.id = 'chat-attach-menu';
        menu.className = 'chat-attach-menu';
        menu.innerHTML = `
            <button type="button" data-action="file"><i class="fas fa-folder-open"></i><span>选择文件：图片/音频/视频</span></button>
            <button type="button" data-action="link"><i class="fas fa-link"></i><span>发送链接卡片</span></button>
        `;
        document.body.appendChild(menu);
        const rect = btn ? btn.getBoundingClientRect() : { left: 12, bottom: window.innerHeight - 80, top: window.innerHeight - 80 };
        menu.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - 230)) + 'px';
        menu.style.bottom = Math.max(72, window.innerHeight - rect.top + 8) + 'px';
        menu.addEventListener('click', e => {
            const actionBtn = e.target.closest('button[data-action]');
            if (!actionBtn) return;
            e.preventDefault();
            e.stopPropagation();
            if (actionBtn.dataset.action === 'file') openAttachFilePicker();
            if (actionBtn.dataset.action === 'link') promptLinkAndSend();
        });
        return false;
    };

    function initAttachmentPlusButton(force = false) {
        const btn = document.getElementById('attachment-btn');
        if (btn && (force || !btn.dataset.plusCleanReady)) {
            const clone = btn.cloneNode(true);
            clone.dataset.plusCleanReady = '1';
            clone.title = '添加附件';
            clone.innerHTML = '<i class="fas fa-plus"></i>';
            btn.parentNode.replaceChild(clone, btn);
            try {
                if (typeof DOMElements !== 'undefined' && DOMElements) DOMElements.attachmentBtn = clone;
            } catch (e) {}
            clone.addEventListener('click', window.toggleChatAttachMenu, true);
        }
        const extra = document.getElementById('attachment-btn-extra');
        if (extra && (force || !extra.dataset.plusCleanReady)) {
            const cloneExtra = extra.cloneNode(true);
            cloneExtra.dataset.plusCleanReady = '1';
            cloneExtra.title = '添加附件';
            cloneExtra.innerHTML = '<i class="fas fa-plus"></i>';
            extra.parentNode.replaceChild(cloneExtra, extra);
            cloneExtra.addEventListener('click', window.toggleChatAttachMenu, true);
        }
        if (!document.documentElement.dataset.chatAttachOutsideReady) {
            document.documentElement.dataset.chatAttachOutsideReady = '1';
            document.addEventListener('click', e => {
                if (!e.target.closest('#chat-attach-menu') && !e.target.closest('#attachment-btn') && !e.target.closest('#attachment-btn-extra')) {
                    closeAttachMenu();
                }
            }, true);
        }
    }

    function initMediaProbabilitySettings() {
        const voiceSlider = document.getElementById('partner-voice-chance-slider');
        const videoSlider = document.getElementById('partner-video-chance-slider');
        const voiceValue = document.getElementById('partner-voice-chance-value');
        const videoValue = document.getElementById('partner-video-chance-value');
        if (!voiceSlider || !videoSlider || voiceSlider.dataset.mediaChanceReady) return;
        voiceSlider.dataset.mediaChanceReady = '1';
        const apply = () => {
            const v = String(Math.max(0, Math.min(100, Number(voiceSlider.value) || 0)));
            const vd = String(Math.max(0, Math.min(100, Number(videoSlider.value) || 0)));
            if (typeof settings !== 'undefined' && settings) {
                settings.partnerVoiceChance = Number(v);
                settings.partnerVideoChance = Number(vd);
            }
            localStorage.setItem('partnerVoiceChance', v);
            localStorage.setItem('partnerVideoChance', vd);
            if (voiceValue) voiceValue.textContent = v + '%';
            if (videoValue) videoValue.textContent = vd + '%';
            if (typeof throttledSaveData === 'function') throttledSaveData();
        };
        const initVoice = (typeof settings !== 'undefined' && settings.partnerVoiceChance != null) ? settings.partnerVoiceChance : (localStorage.getItem('partnerVoiceChance') || 0);
        const initVideo = (typeof settings !== 'undefined' && settings.partnerVideoChance != null) ? settings.partnerVideoChance : (localStorage.getItem('partnerVideoChance') || 0);
        voiceSlider.value = initVoice;
        videoSlider.value = initVideo;
        voiceSlider.addEventListener('input', apply);
        videoSlider.addEventListener('input', apply);
        apply();
    }

    async function startRecording() {
        if (isRecording) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
            notify('当前浏览器不支持录音', 'warning');
            return;
        }
        try {
            recorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            chunks = [];
            const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
            const supportedMime = mimeCandidates.find(type => {
                try { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type); } catch (e) { return false; }
            });
            recorder = supportedMime ? new MediaRecorder(recorderStream, { mimeType: supportedMime }) : new MediaRecorder(recorderStream);
            recordingStart = Date.now();
            isRecording = true;
            showRecordingBar(true);
            recorder.ondataavailable = e => {
                if (e.data && e.data.size) chunks.push(e.data);
            };
            recorder.onstop = async () => {
                if (recorderStream) recorderStream.getTracks().forEach(t => t.stop());
                recorderStream = null;
                const seconds = Math.max(1, Math.round((Date.now() - recordingStart) / 1000));
                if (!chunks.length) {
                    notify('没有录到声音', 'warning');
                    removeRecordingBar();
                    return;
                }
                const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
                pendingRecording = {
                    blob,
                    seconds,
                    name: `语音消息 ${seconds}秒`
                };
                showRecordingBar(false, seconds);
            };
            recorder.start();
            recordingTimer = setInterval(updateRecordingTime, 300);
            notify('正在录音，松开发送前确认', 'info');
        } catch (e) {
            isRecording = false;
            notify('无法访问麦克风，请检查权限', 'warning');
        }
    }

    function stopRecording() {
        if (!isRecording) return;
        isRecording = false;
        clearInterval(recordingTimer);
        if (recorder && recorder.state !== 'inactive') recorder.stop();
    }

    function cancelRecording() {
        isRecording = false;
        clearInterval(recordingTimer);
        pendingRecording = null;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        if (recorderStream) recorderStream.getTracks().forEach(t => t.stop());
        recorderStream = null;
        removeRecordingBar();
    }

    function showRecordingBar(recording, seconds = 0) {
        const wrapper = document.querySelector('.input-area-wrapper');
        if (!wrapper) return;
        let bar = document.getElementById('voice-recording-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'voice-recording-bar';
            bar.className = 'voice-recording-bar';
            const inputArea = wrapper.querySelector('.input-area');
            wrapper.insertBefore(bar, inputArea || wrapper.firstChild);
        }
        bar.innerHTML = recording
            ? `<div class="voice-recording-left"><span class="voice-recording-dot"></span><span>正在录音</span><strong id="voice-recording-time">0秒</strong></div><div class="voice-recording-actions"><button class="voice-cancel-recording" type="button">取消</button></div>`
            : `<div class="voice-recording-left"><i class="fas fa-microphone"></i><span>录音完成</span><strong>${seconds}秒</strong></div><div class="voice-recording-actions"><button class="voice-cancel-recording" type="button">取消</button><button class="voice-send-recording" type="button">发送</button></div>`;
    }

    function updateRecordingTime() {
        const el = document.getElementById('voice-recording-time');
        if (el) el.textContent = Math.max(0, Math.round((Date.now() - recordingStart) / 1000)) + '秒';
    }

    function removeRecordingBar() {
        const bar = document.getElementById('voice-recording-bar');
        if (bar) bar.remove();
    }

    async function sendPendingRecording() {
        if (!pendingRecording) return;
        try {
            const url = await blobToDataURL(pendingRecording.blob);
            addMediaMessage({
                sender: 'user',
                kind: 'audio',
                url,
                name: pendingRecording.name
            });
        } catch (e) {
            notify('录音发送失败', 'error');
        }
        pendingRecording = null;
        removeRecordingBar();
    }

    // 音频播放/停止
    document.addEventListener('click', e => {
        const linkEdit = e.target.closest('.chat-link-edit');
        if (linkEdit) {
            e.preventDefault();
            e.stopImmediatePropagation();
            editLinkNameByButton(linkEdit);
            return;
        }
        const linkCard = e.target.closest('.chat-link-card');
        if (linkCard) {
            e.preventDefault();
            e.stopImmediatePropagation();
            toggleLinkFrame(linkCard);
            return;
        }
        const videoBubble = e.target.closest('.chat-media-video');
        if (videoBubble) {
            e.preventDefault();
            e.stopImmediatePropagation();
            playVideoBubble(videoBubble);
            return;
        }
        const voiceBubble = e.target.closest('.chat-media-audio');
        if (voiceBubble) {
            e.preventDefault();
            e.stopImmediatePropagation();
            toggleAudioBubble(voiceBubble);
            return;
        }
        if (e.target.closest('.voice-send-recording')) {
            sendPendingRecording();
            return;
        }
        if (e.target.closest('.voice-cancel-recording')) {
            pendingRecording = null;
            cancelRecording();
            removeRecordingBar();
        }
    }, true);

    window.editChatLinkName = function(btn, event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        }
        editLinkNameByButton(btn);
        return false;
    };

    function editLinkNameByButton(btn) {
        const card = btn && btn.closest ? btn.closest('.chat-link-card') : null;
        if (!card) return;
        const id = String(card.dataset.linkId || '');
        const titleEl = card.querySelector('.chat-link-title');
        const oldName = titleEl ? titleEl.textContent.trim() : '网页链接';
        const newName = prompt('编辑链接名称：', oldName);
        if (newName === null || !newName.trim()) return;
        if (Array.isArray(window.messages)) {
            const msg = window.messages.find(m => String(m.id) === id);
            if (msg) msg.linkTitle = newName.trim();
        } else if (typeof messages !== 'undefined' && Array.isArray(messages)) {
            const msg = messages.find(m => String(m.id) === id);
            if (msg) msg.linkTitle = newName.trim();
        }
        if (titleEl) titleEl.textContent = newName.trim();
        if (typeof throttledSaveData === 'function') throttledSaveData();
    }

    window.toggleChatLinkFrame = function(card, event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        }
        const target = card && card.closest ? card.closest('.chat-link-card') : null;
        if (target) toggleLinkFrame(target);
        return false;
    };

    function toggleLinkFrame(card) {
        const linkId = card.dataset.linkId;
        const url = (window.__chatLinkUrlStore && linkId ? window.__chatLinkUrlStore[String(linkId)] : '') || card.dataset.linkUrl || '';
        if (!url) {
            notify('链接地址为空', 'warning');
            return;
        }
        const existing = document.getElementById('chat-link-float');
        if (existing && existing.dataset.linkId === String(linkId)) {
            closeLinkFrame();
            return;
        }
        closeLinkFrame();
        const frame = document.createElement('div');
        frame.id = 'chat-link-float';
        frame.className = 'chat-link-float';
        frame.dataset.linkId = String(linkId);
        const host = getUrlHost(url);
        frame.innerHTML = `
            <div class="chat-link-float-header">
                <span><i class="fas fa-link"></i> ${escapeHtml(host)}</span>
                <div class="chat-link-float-actions">
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="浏览器打开"><i class="fas fa-external-link-alt"></i></a>
                    <button type="button" title="关闭"><i class="fas fa-times"></i></button>
                </div>
            </div>
            <iframe class="chat-link-iframe" src="${escapeHtml(url)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer-when-downgrade"></iframe>
            <div class="chat-link-frame-tip">如果页面不显示，请点右上角外部打开</div>
        `;
        document.body.appendChild(frame);
        frame.querySelector('button').addEventListener('click', closeLinkFrame);
    }

    function closeLinkFrame() {
        const frame = document.getElementById('chat-link-float');
        if (frame) frame.remove();
    }

    window.playChatVideoBubble = function(btn, event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        }
        const bubble = btn && btn.closest ? (btn.classList && btn.classList.contains('chat-media-video') ? btn : btn.closest('.chat-media-video')) : null;
        if (bubble) playVideoBubble(bubble);
        return false;
    };

    function playVideoBubble(bubble) {
        const mediaId = bubble.dataset.mediaId;
        const rawUrl = (window.__chatMediaUrlStore && mediaId ? window.__chatMediaUrlStore[String(mediaId)] : '') || bubble.dataset.mediaUrl || '';
        if (!rawUrl) {
            notify('视频地址为空，无法播放', 'warning');
            return;
        }
        stopCurrentAudio();
        closeVideoPlayer();

        const playableUrl = dataUrlToObjectUrl(rawUrl);
        if (/^blob:/i.test(playableUrl)) currentVideoObjectUrl = playableUrl;

        const overlay = document.createElement('div');
        overlay.id = 'chat-video-player-overlay';
        overlay.className = 'chat-video-player-overlay';
        overlay.innerHTML = `
            <div class="chat-video-player-panel" role="dialog" aria-label="视频播放">
                <button class="chat-video-close" type="button" title="关闭视频"><i class="fas fa-times"></i></button>
                <video class="chat-video-direct-player" src="${playableUrl}" controls autoplay playsinline preload="auto"></video>
            </div>
        `;
        document.body.appendChild(overlay);

        const video = overlay.querySelector('video');
        const closeBtn = overlay.querySelector('.chat-video-close');
        const close = () => closeVideoPlayer();
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', evt => {
            if (evt.target === overlay) close();
        });
        document.addEventListener('keydown', handleVideoEsc, true);
        video.play().catch(() => notify('视频已打开，请点击播放按钮', 'info'));
    }

    function handleVideoEsc(e) {
        if (e.key === 'Escape') closeVideoPlayer();
    }

    function closeVideoPlayer() {
        const overlay = document.getElementById('chat-video-player-overlay');
        if (overlay) {
            const video = overlay.querySelector('video');
            if (video) {
                try { video.pause(); } catch (e) {}
                video.removeAttribute('src');
                try { video.load(); } catch (e) {}
            }
            overlay.remove();
        }
        document.removeEventListener('keydown', handleVideoEsc, true);
        if (currentVideoObjectUrl) {
            try { URL.revokeObjectURL(currentVideoObjectUrl); } catch (e) {}
            currentVideoObjectUrl = '';
        }
    }

    window.playChatVoiceBubble = function(btn, event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        }
        const bubble = btn && btn.closest ? (btn.classList && btn.classList.contains('chat-media-audio') ? btn : btn.closest('.chat-media-audio')) : null;
        if (bubble) toggleAudioBubble(bubble);
        return false;
    };

    function toggleAudioBubble(bubble) {
        const audioEl = bubble.querySelector('.chat-audio-player');
        const mediaId = bubble.dataset.mediaId;
        const rawUrl = (window.__chatMediaUrlStore && mediaId ? window.__chatMediaUrlStore[String(mediaId)] : '') || bubble.dataset.mediaUrl || (audioEl && audioEl.getAttribute('src')) || (audioEl && audioEl.src);
        if (!rawUrl) {
            notify('语音地址为空，无法播放', 'warning');
            return;
        }
        if (currentAudioBubble === bubble) {
            stopCurrentAudio();
            return;
        }
        stopCurrentAudio();
        currentAudio = audioEl || new Audio();
        const playableUrl = dataUrlToObjectUrl(rawUrl);
        if (currentAudio.dataset && currentAudio.dataset.objectUrl && currentAudio.dataset.objectUrl !== playableUrl) {
            try { URL.revokeObjectURL(currentAudio.dataset.objectUrl); } catch (e) {}
        }
        currentAudio.src = playableUrl;
        if (currentAudio.dataset && /^blob:/i.test(playableUrl)) currentAudio.dataset.objectUrl = playableUrl;
        currentAudio.preload = 'auto';
        currentAudioBubble = bubble;
        bubble.classList.add('playing');
        const icon = bubble.querySelector('.chat-media-play i');
        if (icon) icon.className = 'fas fa-stop';
        currentAudio.onended = stopCurrentAudio;
        currentAudio.onpause = function() {
            if (currentAudioBubble === bubble && currentAudio && currentAudio.currentTime > 0 && !currentAudio.ended) return;
            if (currentAudioBubble === bubble) stopCurrentAudio();
        };
        currentAudio.onerror = () => {
            notify('语音文件无法读取或已损坏', 'warning');
            stopCurrentAudio();
        };
        try { currentAudio.load(); } catch (e) {}
        currentAudio.play().catch(() => {
            notify('语音播放失败', 'warning');
            stopCurrentAudio();
        });
    }

    function stopCurrentAudio() {
        if (currentAudio) {
            if (currentAudio.dataset && currentAudio.dataset.objectUrl) {
                try { URL.revokeObjectURL(currentAudio.dataset.objectUrl); } catch (e) {}
                delete currentAudio.dataset.objectUrl;
            }
            currentAudio.pause();
            try { currentAudio.currentTime = 0; } catch (e) {}
            currentAudio = null;
        }
        if (currentAudioBubble) {
            currentAudioBubble.classList.remove('playing');
            const icon = currentAudioBubble.querySelector('.chat-media-play i');
            if (icon) icon.className = 'fas fa-play';
            currentAudioBubble = null;
        }
    }

    // 自定义回复库中的语音库/视频库
    window.switchToMediaLibrary = function (kind) {
        const isVoice = kind === 'voice';
        document.querySelectorAll('#custom-replies-modal .sidebar-btn').forEach(btn => btn.classList.remove('active'));
        const activeBtn = document.querySelector(`#custom-replies-modal .sidebar-btn[data-major="${isVoice ? 'voice-media' : 'video-media'}"]`);
        if (activeBtn) activeBtn.classList.add('active');
        const title = document.getElementById('cr-modal-title');
        const tabs = document.getElementById('cr-sub-tabs');
        const list = document.getElementById('custom-replies-list');
        const announcement = document.getElementById('announcement-panel');
        const addBtn = document.getElementById('add-custom-reply');
        const toolbar = document.getElementById('cr-toolbar');
        const voicePanel = document.getElementById('voice-media-panel');
        const videoPanel = document.getElementById('video-media-panel');
        if (title) title.textContent = isVoice ? '语音库管理' : '视频库管理';
        if (tabs) tabs.style.display = 'none';
        if (list) list.style.display = 'none';
        if (announcement) announcement.style.display = 'none';
        if (addBtn) addBtn.style.display = 'none';
        if (toolbar) toolbar.style.display = 'none';
        if (voicePanel) voicePanel.style.display = isVoice ? 'block' : 'none';
        if (videoPanel) videoPanel.style.display = isVoice ? 'none' : 'block';
        renderMediaLibrary(kind);
    };

    function restoreReplyLibraryView() {
        const voicePanel = document.getElementById('voice-media-panel');
        const videoPanel = document.getElementById('video-media-panel');
        if (voicePanel) voicePanel.style.display = 'none';
        if (videoPanel) videoPanel.style.display = 'none';
        const tabs = document.getElementById('cr-sub-tabs');
        const list = document.getElementById('custom-replies-list');
        const addBtn = document.getElementById('add-custom-reply');
        const toolbar = document.getElementById('cr-toolbar');
        if (tabs) tabs.style.display = '';
        if (list) list.style.display = '';
        if (addBtn) addBtn.style.display = '';
        if (toolbar) toolbar.style.display = '';
    }

    document.addEventListener('click', e => {
        const sideBtn = e.target.closest('#custom-replies-modal .sidebar-btn');
        if (sideBtn) {
            const major = sideBtn.dataset.major;
            if (major !== 'voice-media' && major !== 'video-media' && major !== 'announcement') {
                restoreReplyLibraryView();
            }
        }
    }, true);

    window.handleMediaLibraryFiles = async function (input, kind) {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        const targetKind = kind === 'video' ? 'video' : 'voice';
        const acceptPrefix = targetKind === 'video' ? 'video/' : 'audio/';
        let added = 0;
        for (const file of files) {
            if (!file.type.startsWith(acceptPrefix)) continue;
            if (file.size > MAX_MEDIA_SIZE) {
                notify(`${file.name} 超过 30MB，已跳过`, 'warning');
                continue;
            }
            const url = await fileToDataURL(file);
            mediaLibrary[targetKind].push({
                id: Date.now() + Math.random(),
                name: file.name,
                url,
                source: 'file',
                savedAt: Date.now()
            });
            added++;
        }
        if (!added) {
            notify('没有可保存的媒体文件', 'warning');
            input.value = '';
            return;
        }
        const ok = await saveMediaLibrary();
        renderMediaLibrary(targetKind);
        if (ok) notify('媒体库已保存', 'success');
        input.value = '';
    };

    window.importMediaUrl = async function (kind) {
        const targetKind = kind === 'video' ? 'video' : 'voice';
        const label = targetKind === 'video' ? '视频' : '语音';
        const url = prompt(`请输入${label}链接：`);
        if (!url || !url.trim()) return;
        const name = prompt(`请输入${label}名称：`, `${label} ${mediaLibrary[targetKind].length + 1}`) || `${label} ${mediaLibrary[targetKind].length + 1}`;
        mediaLibrary[targetKind].push({
            id: Date.now() + Math.random(),
            name: name.trim(),
            url: url.trim(),
            source: 'link',
            savedAt: Date.now()
        });
        const ok = await saveMediaLibrary();
        renderMediaLibrary(targetKind);
        if (ok) notify('媒体链接已保存', 'success');
    };

    function renderMediaLibrary(kind) {
        const targetKind = kind === 'video' ? 'video' : 'voice';
        const list = document.getElementById(`${targetKind}-media-list`);
        const empty = document.getElementById(`${targetKind}-media-empty`);
        if (!list) return;
        const items = mediaLibrary[targetKind];
        if (!items.length) {
            list.innerHTML = '';
            if (empty) empty.style.display = 'block';
            return;
        }
        if (empty) empty.style.display = 'none';
        list.innerHTML = items.map((item, index) => {
            const icon = targetKind === 'video' ? 'fa-video' : 'fa-microphone';
            const meta = item.source === 'link' ? '链接导入' : '本地上传';
            return `<div class="media-lib-item">
                <div class="media-lib-icon"><i class="fas ${icon}"></i></div>
                <div class="media-lib-main">
                    <div class="media-lib-name">${escapeHtml(item.name)}</div>
                    <div class="media-lib-meta">${meta} · 已保存</div>
                </div>
                <div class="media-lib-actions">
                    <button type="button" onclick="window.previewMediaLibraryItem('${targetKind}', ${index})">预览</button>
                    <button type="button" onclick="window.sendMediaLibraryItem('${targetKind}', ${index}, 'user')">我发送</button>
                    <button type="button" onclick="window.sendMediaLibraryItem('${targetKind}', ${index}, 'partner')">对方发送</button>
                    <button type="button" onclick="window.editMediaLibraryItem('${targetKind}', ${index})">编辑</button>
                    <button type="button" class="danger" onclick="window.deleteMediaLibraryItem('${targetKind}', ${index})">删除</button>
                </div>
            </div>`;
        }).join('');
    }

    window.previewMediaLibraryItem = function (kind, index) {
        const item = mediaLibrary[kind] && mediaLibrary[kind][index];
        if (!item) return;
        if (kind === 'voice') {
            stopCurrentAudio();
            currentAudio = new Audio(item.url);
            currentAudio.play().catch(() => notify('预览播放失败', 'warning'));
            currentAudio.onended = () => { currentAudio = null; };
        } else {
            const w = window.open('', '_blank');
            if (w) {
                w.document.write(`<video src="${item.url}" controls autoplay style="max-width:100%;max-height:100vh;background:#000"></video>`);
            }
        }
    };

    window.sendMediaLibraryItem = function (kind, index, sender) {
        const item = mediaLibrary[kind] && mediaLibrary[kind][index];
        if (!item) return;
        addMediaMessage({
            sender: sender === 'partner' ? 'partner' : 'user',
            kind: kind === 'video' ? 'video' : 'audio',
            url: item.url,
            name: item.name
        });
    };

    window.editMediaLibraryItem = async function (kind, index) {
        const item = mediaLibrary[kind] && mediaLibrary[kind][index];
        if (!item) return;
        const newName = prompt('修改名称：', item.name);
        if (newName === null || !newName.trim()) return;
        item.name = newName.trim();
        await saveMediaLibrary();
        renderMediaLibrary(kind);
    };

    window.deleteMediaLibraryItem = async function (kind, index) {
        if (!mediaLibrary[kind] || !mediaLibrary[kind][index]) return;
        if (!confirm('确定删除这一条吗？')) return;
        mediaLibrary[kind].splice(index, 1);
        await saveMediaLibrary();
        renderMediaLibrary(kind);
    };

    // 关闭按钮兜底：避免弹窗因缺少绑定而关不掉
    document.addEventListener('click', e => {
        const btn = e.target.closest('button, .modal-close, .close-btn');
        if (!btn) return;
        const modal = btn.closest('.modal');
        if (!modal) return;
        const text = (btn.textContent || '').trim();
        if (btn.id === 'close-custom-replies' || text === '关闭' || btn.dataset.closeModal === 'true') {
            if (typeof hideModal === 'function') hideModal(modal);
            else modal.style.display = 'none';
        }
    }, true);

    document.addEventListener('DOMContentLoaded', () => {
        initVideoBubbleSize();
        initPageFit();
        initLongPressVoice();
        initVoiceSendButton();
        initMediaAttachmentInput();
        initAttachmentPlusButton();
        setTimeout(() => initAttachmentPlusButton(true), 0);
        setTimeout(() => initAttachmentPlusButton(true), 300);
        initMediaProbabilitySettings();
        loadMediaLibraryAsync();
    });

    if (document.readyState !== 'loading') {
        initVideoBubbleSize();
        initPageFit();
        initLongPressVoice();
        initVoiceSendButton();
        initMediaAttachmentInput();
        initAttachmentPlusButton();
        setTimeout(() => initAttachmentPlusButton(true), 0);
        setTimeout(() => initAttachmentPlusButton(true), 300);
        initMediaProbabilitySettings();
        loadMediaLibraryAsync();
    }
})();
