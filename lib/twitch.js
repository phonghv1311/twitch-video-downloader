/**
 * lib/twitch.js
 * Tương tác với Twitch GQL API & Usher HLS CDN để trích xuất metadata,
 * chất lượng video, tìm kiếm & lọc nâng cao theo Category, Quốc gia (ưu tiên Views),
 * thời lượng (< hoặc > 30p, 1h, 2h, 4h) và phân tích phân đoạn M3U8.
 */

const { URL } = require('url');
const { fetchJSON, fetchText } = require('./network');

const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL_ENDPOINT = 'https://gql.twitch.tv/gql';

const POPULAR_CATEGORIES = [
  'Just Chatting',
  'Minecraft',
  'VALORANT',
  'Grand Theft Auto V',
  'League of Legends',
  'Dota 2',
  'Counter-Strike',
  'Fortnite',
  'Apex Legends',
  'Overwatch 2',
  'Elden Ring',
  'World of Warcraft'
];

const COUNTRY_OPTIONS = [
  { code: 'all', name: 'Toàn cầu (Tất cả)', flag: '🌐', channels: ['caseoh_', 'tfue', 'tarik', 'kaicenat', 'xqc'] },
  { code: 'vi', name: 'Việt Nam (VN)', flag: '🇻🇳', langs: ['vi', 'vie', 'vietnamese'], channels: ['bomman', 'dramatickk', 'optimus', 'mimosa_k', 'thaygiaoba'] },
  { code: 'en', name: 'Mỹ / Quốc tế (US/EN)', flag: '🇺🇸', langs: ['en', 'eng', 'english'], channels: ['caseoh_', 'tfue', 'tarik', 'kaicenat', 'xqc', 'shroud', 'jynxzi'] },
  { code: 'ja', name: 'Nhật Bản (JP)', flag: '🇯🇵', langs: ['ja', 'jpn', 'japanese'], channels: ['kato_junichi0817', 'fps_shaka', 'stylishnoob4', 'sasatikk', 'darumaisgod'] },
  { code: 'ko', name: 'Hàn Quốc (KR)', flag: '🇰🇷', langs: ['ko', 'kor', 'korean'], channels: ['handongsuk', 'woowakgood', 't1_faker'] },
  { code: 'es', name: 'Tây Ban Nha / Mỹ Latinh (ES)', flag: '🇪🇸', langs: ['es', 'spa', 'spanish'], channels: ['ibai', 'auronplay', 'rubius', 'elxokas'] },
  { code: 'fr', name: 'Pháp (FR)', flag: '🇫🇷', langs: ['fr', 'fra', 'french'], channels: ['kamet0', 'squeezie', 'gotaga', 'aminematue'] },
  { code: 'de', name: 'Đức (DE)', flag: '🇩🇪', langs: ['de', 'deu', 'german'], channels: ['eliasn97', 'montanablack88', 'papaplatte', 'trymacs'] },
  { code: 'pt', name: 'Bồ Đào Nha / Brazil (PT/BR)', flag: '🇧🇷', langs: ['pt', 'por', 'portuguese'], channels: ['gaules', 'alanzoka', 'loud_coringa'] },
  { code: 'ru', name: 'Nga (RU)', flag: '🇷🇺', langs: ['ru', 'rus', 'russian'], channels: ['buster', 'bratishkinoff', 'deepins02'] },
  { code: 'th', name: 'Thái Lan (TH)', flag: '🇹🇭', langs: ['th', 'tha', 'thai'], channels: ['fpsthailand', 'viperdemon', 'mithstreamer'] }
];

function parseTwitchUrl(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new Error('Vui lòng nhập đường link Twitch hợp lệ.');
  }

  const input = rawInput.trim();

  const clipsDomainMatch = input.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/i);
  if (clipsDomainMatch) {
    return { type: 'clip', slug: clipsDomainMatch[1] };
  }

  const twitchClipMatch = input.match(/twitch\.tv\/(?:[A-Za-z0-9_]+\/)?clip\/([A-Za-z0-9_-]+)/i);
  if (twitchClipMatch) {
    return { type: 'clip', slug: twitchClipMatch[1] };
  }

  const vodMatch = input.match(/twitch\.tv\/videos\/(\d+)/i);
  if (vodMatch) {
    return { type: 'vod', id: vodMatch[1] };
  }

  if (/^\d+$/.test(input)) {
    return { type: 'vod', id: input };
  }

  const channelMatch = input.match(/twitch\.tv\/([A-Za-z0-9_]+)\/?$/i);
  if (channelMatch && !['videos', 'directory', 'downloads', 'settings', 'p'].includes(channelMatch[1].toLowerCase())) {
    return { type: 'channel', login: channelMatch[1].toLowerCase() };
  }

  if (/^[A-Za-z0-9_-]+$/.test(input)) {
    return { type: 'clip', slug: input };
  }

  throw new Error(`Đường dẫn Twitch không hợp lệ: "${input}". Vui lòng nhập link VOD (videos/...), Clip (clip/...) hoặc Kênh Live.`);
}

async function gqlRequest(query, variables = {}) {
  const payload = { query, variables };
  const res = await fetchJSON(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(`Lỗi Twitch GQL: ${res.errors.map(e => e.message).join(', ')}`);
  }
  return res.data;
}

async function getVodAccessToken(vodId) {
  const query = `
    query GetVodAccessToken($vodID: ID!) {
      videoPlaybackAccessToken(
        id: $vodID,
        params: {
          platform: "web",
          playerBackend: "mediaplayer",
          playerType: "site"
        }
      ) {
        value
        signature
      }
    }
  `;

  const data = await gqlRequest(query, { vodID: vodId });
  const token = data?.videoPlaybackAccessToken;
  if (!token) {
    throw new Error(`Không thể lấy mã bảo mật (Playback Access Token) cho VOD ${vodId}. Video có thể đã bị xóa hoặc yêu cầu đăng nhập Subscriber.`);
  }
  return token;
}

async function getVodInfo(vodId) {
  const query = `
    query GetVideoMetadata($id: ID!) {
      video(id: $id) {
        id
        title
        description
        lengthSeconds
        createdAt
        publishedAt
        viewCount
        previewThumbnailURL(height: 360, width: 640)
        owner {
          id
          login
          displayName
        }
        game {
          id
          name
          boxArtURL
        }
      }
    }
  `;

  const data = await gqlRequest(query, { id: vodId });
  const video = data?.video;
  if (!video) {
    throw new Error(`Không tìm thấy Twitch Video VOD với mã: "${vodId}". Video có thể đã bị xóa.`);
  }

  const token = await getVodAccessToken(vodId);
  const usherUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?nauth=${encodeURIComponent(token.value)}&nauthsig=${token.signature}&allow_source=true&allow_audio_only=true`;

  const m3u8MasterContent = await fetchText(usherUrl);
  const rawQualities = parseMasterM3u8(m3u8MasterContent);

  const sourceQuality = rawQualities.find(q => q.isSource) || rawQualities[0] || {};
  const sourceUrl = sourceQuality.url || '';

  const qualities = [
    {
      id: '1080p',
      label: '1080p Full HD (1920x1080, 16:9) - Chuẩn CapCut [Mặc định]',
      resolution: '1920x1080',
      targetResolution: '1080p',
      fps: sourceQuality.fps || 60,
      url: sourceUrl,
      isSource: true
    },
    {
      id: '2k',
      label: '2K QHD (2560x1440, 16:9) - Siêu sắc nét cho CapCut',
      resolution: '2560x1440',
      targetResolution: '2k',
      fps: sourceQuality.fps || 60,
      url: sourceUrl,
      isSource: false
    }
  ];

  return {
    type: 'vod',
    id: video.id,
    title: video.title || 'Twitch Video VOD',
    description: video.description || '',
    broadcaster: video.owner?.displayName || video.owner?.login || 'Ẩn danh',
    broadcasterLogin: video.owner?.login || '',
    game: video.game?.name || 'Chưa phân loại',
    durationSeconds: video.lengthSeconds || 0,
    formattedDuration: formatDuration(video.lengthSeconds || 0),
    viewCount: video.viewCount || 0,
    createdAt: video.createdAt,
    thumbnailUrl: video.previewThumbnailURL,
    qualities
  };
}

async function getClipInfo(slug) {
  const query = `
    query GetClipMetadata($slug: ID!) {
      clip(slug: $slug) {
        id
        slug
        title
        viewCount
        createdAt
        durationSeconds
        thumbnailURL
        broadcaster {
          displayName
          login
        }
        curator {
          displayName
          login
        }
        game {
          name
        }
        playbackAccessToken(params: {platform: "web", playerType: "site"}) {
          signature
          value
        }
        videoQualities {
          frameRate
          quality
          sourceURL
        }
      }
    }
  `;

  const data = await gqlRequest(query, { slug });
  const clip = data?.clip;
  if (!clip) {
    throw new Error(`Không tìm thấy Twitch Clip với mã: "${slug}". Clip có thể đã bị xóa hoặc đặt ở chế độ riêng tư.`);
  }

  const token = clip.playbackAccessToken;
  const tokenQuery = (token && token.signature && token.value)
    ? `?sig=${token.signature}&token=${encodeURIComponent(token.value)}`
    : '';

  const raw1080 = (clip.videoQualities || []).find(q => q.quality === '1080') || (clip.videoQualities || [])[0];
  const sourceDirectUrl = raw1080 ? `${raw1080.sourceURL}${tokenQuery}` : '';

  const qualities = [
    {
      id: '1080p',
      label: '1080p Full HD (1920x1080, 16:9) - Chuẩn CapCut [Mặc định]',
      resolution: '1920x1080',
      targetResolution: '1080p',
      fps: raw1080?.frameRate || 60,
      url: sourceDirectUrl,
      isSource: true
    },
    {
      id: '2k',
      label: '2K QHD (2560x1440, 16:9) - Siêu sắc nét cho CapCut',
      resolution: '2560x1440',
      targetResolution: '2k',
      fps: raw1080?.frameRate || 60,
      url: sourceDirectUrl,
      isSource: false
    }
  ];

  return {
    type: 'clip',
    id: clip.id,
    slug: clip.slug,
    title: clip.title || 'Twitch Clip',
    broadcaster: clip.broadcaster?.displayName || clip.broadcaster?.login || 'Ẩn danh',
    broadcasterLogin: clip.broadcaster?.login || '',
    curator: clip.curator?.displayName || '',
    game: clip.game?.name || 'Chưa phân loại',
    durationSeconds: clip.durationSeconds || 0,
    formattedDuration: formatDuration(clip.durationSeconds || 0),
    viewCount: clip.viewCount || 0,
    createdAt: clip.createdAt,
    thumbnailUrl: clip.thumbnailURL,
    qualities
  };
}

function parseMasterM3u8(m3u8Content) {
  const lines = m3u8Content.split(/\r?\n/);
  const qualities = [];
  let currentInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA:TYPE=VIDEO') || line.startsWith('#EXT-X-STREAM-INF:')) {
      if (!currentInfo) currentInfo = {};

      const nameMatch = line.match(/NAME="([^"]+)"/);
      if (nameMatch) currentInfo.name = nameMatch[1];

      const groupIdMatch = line.match(/GROUP-ID="([^"]+)"/);
      if (groupIdMatch) currentInfo.groupId = groupIdMatch[1];

      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      if (resMatch) currentInfo.resolution = resMatch[1];

      const fpsMatch = line.match(/FRAME-RATE=([0-9.]+)/);
      if (fpsMatch) currentInfo.fps = Math.round(parseFloat(fpsMatch[1]));

      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      if (bwMatch) currentInfo.bandwidth = parseInt(bwMatch[1], 10);
    } else if (line.startsWith('http://') || line.startsWith('https://')) {
      const isSource = currentInfo?.groupId === 'chunked' || currentInfo?.name?.includes('source') || currentInfo?.name === '1080p60';
      qualities.push({
        id: currentInfo?.groupId || currentInfo?.name || `q_${qualities.length}`,
        label: currentInfo?.name || currentInfo?.resolution || 'Stream',
        resolution: currentInfo?.resolution || '1920x1080',
        fps: currentInfo?.fps || 60,
        bandwidth: currentInfo?.bandwidth || 0,
        isSource: Boolean(isSource),
        url: line
      });
      currentInfo = null;
    }
  }

  qualities.sort((a, b) => {
    if (a.isSource && !b.isSource) return -1;
    if (!a.isSource && b.isSource) return 1;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });

  return qualities;
}

async function parseSubPlaylistSegments(subM3u8Url, startTimeSec = 0, endTimeSec = null) {
  const content = await fetchText(subM3u8Url);
  const lines = content.split(/\r?\n/);
  const baseUrl = subM3u8Url.substring(0, subM3u8Url.lastIndexOf('/') + 1);

  const rawSegments = [];
  let currentDuration = 0;
  let totalVideoDuration = 0;
  let currentInitUrl = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MAP:')) {
      const match = line.match(/URI="([^"]+)"/);
      if (match) {
        currentInitUrl = (match[1].startsWith('http://') || match[1].startsWith('https://'))
          ? match[1]
          : new URL(match[1], baseUrl).toString();
      }
    } else if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:([0-9.]+)/);
      currentDuration = match ? parseFloat(match[1]) : 0;
    } else if (!line.startsWith('#')) {
      const segUrl = (line.startsWith('http://') || line.startsWith('https://'))
        ? line
        : new URL(line, baseUrl).toString();

      const segStart = totalVideoDuration;
      const segEnd = totalVideoDuration + currentDuration;
      totalVideoDuration = segEnd;

      rawSegments.push({
        index: rawSegments.length,
        url: segUrl,
        duration: currentDuration,
        startTime: segStart,
        endTime: segEnd,
        initUrl: currentInitUrl
      });

      currentDuration = 0;
    }
  }

  const actualEnd = (endTimeSec !== null && endTimeSec > 0 && endTimeSec <= totalVideoDuration)
    ? endTimeSec
    : totalVideoDuration;

  const filteredSegments = rawSegments.filter(seg => {
    return seg.endTime > startTimeSec && seg.startTime < actualEnd;
  });

  const selectedDuration = filteredSegments.reduce((sum, s) => sum + s.duration, 0);

  return {
    totalSegments: rawSegments.length,
    totalDuration: totalVideoDuration,
    selectedSegments: filteredSegments,
    selectedDuration,
    startTimeSec,
    endTimeSec: actualEnd,
    initUrl: currentInitUrl,
    isFmp4: Boolean(currentInitUrl)
  };
}

/**
 * YÊU CẦU 1 & 2: Tìm kiếm & Lọc video/clips theo:
 * - Quốc gia (ưu tiên video xem nhiều theo quốc gia)
 * - Category
 * - Thời lượng (< hoặc > 30p, 1h, 2h, 4h, 8h)
 * - Sắp xếp Lượt xem nhiều nhất (Views DESC), Mới nhất (Recent)
 */
async function searchTwitchVideosAndClips({
  query = '',
  category = 'all',
  country = 'all', // Yêu cầu 2: 'all', 'vi', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'th'
  videoType = 'all', // 'all', 'vod', 'clip'
  minDuration = 0, // Yêu cầu 3: Lọc khoảng thời lượng Between (giây hoặc '00:30:00')
  maxDuration = 0, // Yêu cầu 3: Lọc khoảng thời lượng Between (giây hoặc '04:00:00')
  durationFrom = 0,
  durationTo = 0,
  hoursFilter = 'all', // Tương thích ngược: 'all', 'lt_30m', 'gt_30m', 'lt_1', 'gt_1', 'lt_2', 'gt_2', 'lt_4', 'gt_4', 'gt_8'
  sortBy = 'views', // 'views', 'recent', 'duration_desc', 'duration_asc'
  limit = 30
} = {}) {
  const searchQuery = (query || '').trim();
  const targetCategory = (category && category !== 'all') ? category.trim() : (searchQuery || 'Just Chatting');

  // Xác định kênh mục tiêu nếu lọc theo Quốc gia
  const countryObj = COUNTRY_OPTIONS.find(c => c.code === country) || COUNTRY_OPTIONS[0];
  const targetChannel = searchQuery || (countryObj.channels ? countryObj.channels[0] : 'caseoh_');

  const combinedSearchGQL = `
    query SearchChannelAndCategory($channel: String!, $game: String!, $sortOrder: VideoSort) {
      user(login: $channel) {
        id
        login
        displayName
        profileImageURL(width: 150)
        videos(first: 30, sort: $sortOrder) {
          edges {
            node {
              id
              title
              lengthSeconds
              viewCount
              createdAt
              previewThumbnailURL(height: 180, width: 320)
              game {
                name
              }
            }
          }
        }
        clips(first: 30) {
          edges {
            node {
              slug
              title
              durationSeconds
              viewCount
              createdAt
              thumbnailURL
              broadcaster {
                displayName
                login
              }
              game {
                name
              }
            }
          }
        }
      }
      game(name: $game) {
        id
        name
        boxArtURL
        videos(first: 30, sort: $sortOrder) {
          edges {
            node {
              id
              title
              lengthSeconds
              viewCount
              createdAt
              previewThumbnailURL(height: 180, width: 320)
              owner {
                displayName
                login
              }
              game {
                name
              }
            }
          }
        }
        clips(first: 30) {
          edges {
            node {
              slug
              title
              durationSeconds
              viewCount
              createdAt
              thumbnailURL
              broadcaster {
                displayName
                login
              }
            }
          }
        }
      }
      streams(first: 30, options: {sort: VIEWER_COUNT}) {
        edges {
          node {
            id
            viewersCount
            broadcaster {
              login
              displayName
              broadcastSettings {
                language
                title
                game {
                  name
                }
              }
              videos(first: 5, sort: VIEWS) {
                edges {
                  node {
                    id
                    title
                    lengthSeconds
                    viewCount
                    createdAt
                    previewThumbnailURL(height: 180, width: 320)
                    game {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const sortGql = (sortBy === 'recent') ? 'TIME' : 'VIEWS';

  const data = await gqlRequest(combinedSearchGQL, {
    channel: targetChannel,
    game: targetCategory,
    sortOrder: sortGql
  });

  const results = [];

  // 1. Trích xuất VODs từ Streamer chỉ định
  if (data?.user?.videos?.edges) {
    for (const edge of data.user.videos.edges) {
      const v = edge.node;
      results.push({
        id: v.id,
        type: 'vod',
        title: v.title || 'Twitch Stream',
        broadcaster: data.user.displayName || data.user.login,
        broadcasterLogin: data.user.login,
        game: v.game?.name || targetCategory,
        durationSeconds: v.lengthSeconds || 0,
        formattedDuration: formatDuration(v.lengthSeconds || 0),
        viewCount: v.viewCount || 0,
        createdAt: v.createdAt,
        thumbnailUrl: v.previewThumbnailURL,
        url: `https://www.twitch.tv/videos/${v.id}`,
        country: countryObj.code
      });
    }
  }

  // 2. Trích xuất Clips từ Streamer chỉ định
  if (data?.user?.clips?.edges) {
    for (const edge of data.user.clips.edges) {
      const c = edge.node;
      results.push({
        id: c.slug,
        type: 'clip',
        title: c.title || 'Twitch Clip',
        broadcaster: c.broadcaster?.displayName || data.user.displayName,
        broadcasterLogin: c.broadcaster?.login || data.user.login,
        game: c.game?.name || targetCategory,
        durationSeconds: c.durationSeconds || 0,
        formattedDuration: formatDuration(c.durationSeconds || 0),
        viewCount: c.viewCount || 0,
        createdAt: c.createdAt,
        thumbnailUrl: c.thumbnailURL,
        url: `https://clips.twitch.tv/${c.slug}`,
        country: countryObj.code
      });
    }
  }

  // 3. Trích xuất VODs từ Game / Category
  if (data?.game?.videos?.edges) {
    for (const edge of data.game.videos.edges) {
      const v = edge.node;
      if (!results.some(r => r.id === v.id)) {
        results.push({
          id: v.id,
          type: 'vod',
          title: v.title || 'Twitch Stream',
          broadcaster: v.owner?.displayName || v.owner?.login || 'Streamer',
          broadcasterLogin: v.owner?.login || '',
          game: data.game.name,
          durationSeconds: v.lengthSeconds || 0,
          formattedDuration: formatDuration(v.lengthSeconds || 0),
          viewCount: v.viewCount || 0,
          createdAt: v.createdAt,
          thumbnailUrl: v.previewThumbnailURL,
          url: `https://www.twitch.tv/videos/${v.id}`,
          country: countryObj.code
        });
      }
    }
  }

  // 4. Trích xuất Clips từ Game / Category
  if (data?.game?.clips?.edges) {
    for (const edge of data.game.clips.edges) {
      const c = edge.node;
      if (!results.some(r => r.id === c.slug)) {
        results.push({
          id: c.slug,
          type: 'clip',
          title: c.title || 'Twitch Clip',
          broadcaster: c.broadcaster?.displayName || c.broadcaster?.login || 'Streamer',
          broadcasterLogin: c.broadcaster?.login || '',
          game: data.game.name,
          durationSeconds: c.durationSeconds || 0,
          formattedDuration: formatDuration(c.durationSeconds || 0),
          viewCount: c.viewCount || 0,
          createdAt: c.createdAt,
          thumbnailUrl: c.thumbnailURL,
          url: `https://clips.twitch.tv/${c.slug}`,
          country: countryObj.code
        });
      }
    }
  }

  // 5. Trích xuất video từ Top Live Streams theo ngôn ngữ / quốc gia
  if (data?.streams?.edges) {
    for (const s of data.streams.edges) {
      const bc = s.node?.broadcaster;
      const sLang = (bc?.broadcastSettings?.language || '').toLowerCase();

      // Nếu người dùng chọn quốc gia cụ thể, chỉ lấy broadcaster trùng ngôn ngữ
      if (country !== 'all') {
        const matchesLang = countryObj.langs && countryObj.langs.some(l => sLang.includes(l));
        if (!matchesLang && country !== 'all') continue;
      }

      if (bc?.videos?.edges) {
        for (const vEdge of bc.videos.edges) {
          const v = vEdge.node;
          if (!results.some(r => r.id === v.id)) {
            results.push({
              id: v.id,
              type: 'vod',
              title: v.title || bc.broadcastSettings?.title || 'Twitch Video',
              broadcaster: bc.displayName || bc.login,
              broadcasterLogin: bc.login,
              game: v.game?.name || bc.broadcastSettings?.game?.name || 'Twitch',
              durationSeconds: v.lengthSeconds || 0,
              formattedDuration: formatDuration(v.lengthSeconds || 0),
              viewCount: v.viewCount || 0,
              createdAt: v.createdAt,
              thumbnailUrl: v.previewThumbnailURL,
              url: `https://www.twitch.tv/videos/${v.id}`,
              country: sLang || countryObj.code
            });
          }
        }
      }
    }
  }

  // ==================== BỘ LỌC NÂNG CAO ====================
  let filtered = results;

  // Lọc theo loại video
  if (videoType === 'vod') {
    filtered = filtered.filter(item => item.type === 'vod');
  } else if (videoType === 'clip') {
    filtered = filtered.filter(item => item.type === 'clip');
  }

  // YÊU CẦU 3: LỌC THEO KHOẢNG THỜI GIAN (Between: Min -> Max)
  const minSec = parseTimeToSeconds(minDuration || durationFrom || 0);
  const maxSec = parseTimeToSeconds(maxDuration || durationTo || 0);

  if (minSec > 0) {
    filtered = filtered.filter(item => item.durationSeconds >= minSec);
  }
  if (maxSec > 0) {
    filtered = filtered.filter(item => item.durationSeconds <= maxSec);
  }

  // Tương thích ngược với hoursFilter nếu không truyền min/max
  if (hoursFilter && hoursFilter !== 'all' && minSec === 0 && maxSec === 0) {
    if (hoursFilter === 'lt_30m') {
      filtered = filtered.filter(item => item.durationSeconds < 1800); // < 30 phút
    } else if (hoursFilter === 'gt_30m') {
      filtered = filtered.filter(item => item.durationSeconds >= 1800); // > 30 phút
    } else if (hoursFilter === 'lt_1') {
      filtered = filtered.filter(item => item.durationSeconds < 3600); // < 1 giờ
    } else if (hoursFilter === 'gt_1') {
      filtered = filtered.filter(item => item.durationSeconds >= 3600); // > 1 giờ
    } else if (hoursFilter === 'lt_2') {
      filtered = filtered.filter(item => item.durationSeconds < 7200); // < 2 giờ
    } else if (hoursFilter === 'gt_2') {
      filtered = filtered.filter(item => item.durationSeconds >= 7200); // > 2 giờ
    } else if (hoursFilter === 'lt_4') {
      filtered = filtered.filter(item => item.durationSeconds < 14400); // < 4 giờ
    } else if (hoursFilter === 'gt_4') {
      filtered = filtered.filter(item => item.durationSeconds >= 14400); // > 4 giờ
    } else if (hoursFilter === 'gt_8') {
      filtered = filtered.filter(item => item.durationSeconds >= 28800); // > 8 giờ
    }
  }

  // Lọc từ khóa bổ sung nếu có
  if (searchQuery && searchQuery !== targetCategory) {
    const qLower = searchQuery.toLowerCase();
    filtered = filtered.filter(item =>
      item.title.toLowerCase().includes(qLower) ||
      item.broadcaster.toLowerCase().includes(qLower) ||
      item.game.toLowerCase().includes(qLower)
    );
  }

  // YÊU CẦU 2: ƯU TIÊN VIDEO ĐƯỢC XEM NHIỀU THEO QUỐC GIA (Views DESC mặc định)
  if (sortBy === 'recent') {
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (sortBy === 'duration_desc') {
    filtered.sort((a, b) => b.durationSeconds - a.durationSeconds);
  } else if (sortBy === 'duration_asc') {
    filtered.sort((a, b) => a.durationSeconds - b.durationSeconds);
  } else {
    // 'views' hoặc mặc định: Ưu tiên video được xem nhiều nhất
    filtered.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
  }

  return {
    items: filtered.slice(0, limit),
    totalCount: filtered.length,
    popularCategories: POPULAR_CATEGORIES,
    countryOptions: COUNTRY_OPTIONS,
    activeCountry: countryObj
  };
}

function formatDuration(seconds) {
  const sec = Math.floor(seconds || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  if (typeof timeStr === 'number') return timeStr;

  const parts = timeStr.toString().trim().split(':').map(p => parseFloat(p) || 0);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }
  return 0;
}

module.exports = {
  parseTwitchUrl,
  getClipInfo,
  getVodInfo,
  parseSubPlaylistSegments,
  searchTwitchVideosAndClips,
  formatDuration,
  parseTimeToSeconds,
  POPULAR_CATEGORIES,
  COUNTRY_OPTIONS
};
