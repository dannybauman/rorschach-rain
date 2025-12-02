const https = require('https');

https.get('https://api.rainviewer.com/public/weather-maps.json', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('Host:', json.host);
      console.log('Past Count:', json.radar.past.length);
      if (json.radar.past.length > 0) {
        console.log('First Past:', json.radar.past[0]);
        console.log('Last Past:', json.radar.past[json.radar.past.length - 1]);
      }
      console.log('Nowcast Count:', json.radar.nowcast.length);
      if (json.radar.nowcast.length > 0) {
        console.log('First Nowcast:', json.radar.nowcast[0]);
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  });
}).on('error', (e) => {
  console.error('Fetch error:', e);
});
