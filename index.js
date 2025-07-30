const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const { createClient } = require('@vercel/kv');

const app = express();
app.use(express.json());

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

let PQueue;
let queue;

async function initQueue() {
  if (!PQueue) {
    const { default: PQueueModule } = await import('p-queue');
    PQueue = PQueueModule;
    queue = new PQueue({ concurrency: 1 });
    console.log('PQueue initialized');
  }
}

app.get('/parse_xiaohongshu', async (req, res) => {
  console.log('Request received:', req.query);
  const { url } = req.query;
  if (!url || !url.includes('xhslink.com')) {
    console.log('Invalid URL:', url);
    return res.status(400).json({ error: '无效的小红书短链接' });
  }

  const cacheKey = `xhs:${url}`;
  try {
    console.log('Checking cache for key:', cacheKey);
    const cached = await kv.get(cacheKey);
    if (cached) {
      console.log('Cache hit:', cacheKey);
      return res.json(cached);
    }
  } catch (error) {
    console.error('KV cache error:', error.message);
  }

  try {
    await initQueue();
    console.log('Resolving short URL:', url);
    const fullUrl = await resolveShortUrl(url);
    if (!fullUrl.includes('xiaohongshu.com')) {
      console.log('Invalid resolved URL:', fullUrl);
      return res.status(400).json({ error: '解析后的 URL 无效' });
    }

    console.log('Scraping media from:', fullUrl);
    const mediaLinks = await queue.add(() => scrapeMedia(fullUrl));
    const result = { status: 'success', data: { resolvedUrl: fullUrl, media: mediaLinks } };
    
    try {
      console.log('Saving to cache:', cacheKey);
      await kv.set(cacheKey, result, { ex: 3600 });
    } catch (error) {
      console.error('KV save error:', error.message);
    }
    
    res.json(result);
  } catch (error) {
    console.error('Processing error:', error.message);
    res.status(500).json({ error: `处理失败: ${error.message}` });
  }
});

async function resolveShortUrl(shortUrl) {
  try {
    const response = await axios.get(shortUrl, {
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 XiaoHongShu/8.0.0',
        'Referer': 'https://www.xiaohongshu.com'
      },
      timeout: 5000
    });
    return response.request.res.responseUrl;
  } catch (error) {
    throw new Error(`解析短链接失败: ${error.message}`);
  }
}

async function scrapeMedia(fullUrl) {
  let browser;
  try {
    console.log('Connecting to Browserless');
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
      connectTimeout: 10000
    });
    console.log('Browser connected');

    const page = await browser.newPage();
    const appUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 XiaoHongShu/8.0.0';
    await page.setExtraHTTPHeaders({
      'User-Agent': appUA,
      'Referer': 'https://www.xiaohongshu.com',
      'X-Requested-With': 'XMLHttpRequest'
    });

    await page.setRequestInterception(true);
    page.on('request', request => {
      if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    console.log('Navigating to:', fullUrl);
    await gotoWithRetry(page, fullUrl);

    const mediaLinks = { images: [], videos: [] };
    const images = await page.$$eval('img', imgs =>
      imgs.map(img => img.src).filter(src => src && src.match(/\.(jpg|png|jpeg)$/i))
    );
    mediaLinks.images = images;

    const videos = await page.$$eval('video', vids =>
      vids.map(vid => vid.src).filter(src => src)
    );
    mediaLinks.videos = videos;

    page.on('response', async response => {
      if (response.url().includes('/api/sns/v1/note')) {
        try {
          const data = await response.json();
          if (data?.data?.note?.images_list) {
            mediaLinks.images.push(...data.data.note.images_list.map(img => img.url));
          }
          if (data?.data?.note?.video?.url) {
            mediaLinks.videos.push(data.data.note.video.url);
          }
        } catch {}
      }
    });

    await page.waitForTimeout(1000);
    return mediaLinks;
  } catch (error) {
    throw new Error(`抓取媒体失败: ${error.message}`);
  } finally {
    if (browser) {
      console.log('Closing browser');
      await browser.close();
    }
  }
}

async function gotoWithRetry(page, url) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      return;
    } catch (error) {
      console.error(`Navigation attempt ${i + 1} failed: ${error.message}`);
      if (i === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

module.exports = app;