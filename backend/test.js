const fetch = require('node-fetch');
async function test() {
    try {
        const ep = 'http://127.0.0.1:9080/api/channels';
        const response = await fetch(ep, { timeout: 8000 });
        let rawJson = await response.json();
        let jsonChannels = Array.isArray(rawJson) ? rawJson : (rawJson.channels || null);
        console.log("Is Array now?", Array.isArray(jsonChannels));
        console.log("Length:", jsonChannels ? jsonChannels.length : 0);
    } catch (e) {
        console.error(e);
    }
}
test();
