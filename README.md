# Lakeside · Tahmina Sultana

An interactive 3D lakeside world built with three.js: a mountain lake with Gerstner waves, a spruce forest that sways in a shared wind field, a lake house on stilts with a working door and a physics-driven fireplace, and a day/night cycle.

Live: https://lakeside-portfolio.vercel.app
Main portfolio: https://portfolio-tahmina5.vercel.app

## Run locally

Static files, no build step:

```bash
python3 -m http.server 5175
# open http://localhost:5175
```

three.js is loaded from the jsDelivr CDN via an import map.

Deploys automatically to Vercel on every push to `main`.
