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

let PQueue; // 延迟初始化 PQueue
let queue; // 延迟初始化 queue

// 初始化 PQueue
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
    await initQueue(); // 确保 queue 已初始化
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
      await kv.set(cacheKey, result, { ex: 3600 }); // 缓存 1 小时
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 5000 // 5 秒超时
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
      connectTimeout: 10000 // 10 秒连接超时
    });
    console.log('Browser connected');

    const page = await browser.newPage();
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15'
    ];
    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setExtraHTTPHeaders({ 'User-Agent': randomUA });

    await page.setRequestInterception(true);
    page.on('request', request => {
      if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    console.log('Navigating to:', fullUrl);
    await page.goto(fullUrl, { waitUntil: 'networkidle0', timeout: 15000 });

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
      if (response.url().includes('api') && response.url().includes('json')) {
        try {
          const data = await response.json();
          if (data?.video?.url) {
            mediaLinks.videos.push(data.video.url);
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

module.exports = app;