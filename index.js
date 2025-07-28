const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// API 端点：解析小红书短链接并提取媒体
app.get('/parse_xiaohongshu', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes('xhslink.com')) {
    return res.status(400).json({ error: '无效的小红书短链接' });
  }

  try {
    // 解析短链接
    const fullUrl = await resolveShortUrl(url);
    if (!fullUrl.includes('xiaohongshu.com')) {
      return res.status(400).json({ error: '解析后的 URL 无效' });
    }

    // 提取媒体链接
    const mediaLinks = await scrapeMedia(fullUrl);
    res.json({ status: 'success', data: { resolvedUrl: fullUrl, media: mediaLinks } });
  } catch (error) {
    res.status(500).json({ error: `处理失败: ${error.message}` });
  }
});

// 解析短链接
async function resolveShortUrl(shortUrl) {
  try {
    const response = await axios.get(shortUrl, {
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    return response.request.res.responseUrl;
  } catch (error) {
    throw new Error(`解析短链接失败: ${error.message}`);
  }
}

// 提取图片和视频链接
async function scrapeMedia(fullUrl) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process' // 优化内存
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    ignoreDefaultArgs: ['--disable-extensions'] // 避免默认参数冲突
  });

  try {
    const page = await browser.newPage();
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15'
    ];
    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setExtraHTTPHeaders({ 'User-Agent': randomUA });

    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

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

    await page.waitForTimeout(5000);
    return mediaLinks;
  } finally {
    await browser.close();
  }
}

module.exports = app;