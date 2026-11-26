const driverDocumentScan = (() => {
  const maxSourceEdge = 3200;
  const maxScanEdge = 2800;

  function canvas(width, height) {
    const result = document.createElement('canvas');
    result.width = width;
    result.height = height;
    return result;
  }

  function fit(width, height, edge) {
    const scale = Math.min(1, edge / Math.max(width, height));
    return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
  }

  async function read(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const source = canvas(...fit(image.naturalWidth, image.naturalHeight, maxSourceEdge));
      if (Math.min(source.width, source.height) < 32) throw new Error('Take a closer photo of the entire page.');
      const context = source.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, source.width, source.height);
      context.drawImage(image, 0, 0, source.width, source.height);
      return source;
    } finally { URL.revokeObjectURL(url); }
  }

  function luminance(source) {
    const pixels = source.getContext('2d').getImageData(0, 0, source.width, source.height).data;
    const gray = new Uint8Array(source.width * source.height);
    for (let i = 0, offset = 0; i < gray.length; i++, offset += 4) {
      gray[i] = (pixels[offset] * 77 + pixels[offset + 1] * 150 + pixels[offset + 2] * 29 + 128) >> 8;
    }
    return gray;
  }

  function fullPage({ width, height }) {
    return [{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }];
  }

  function cross(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function area(points) {
    return points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2;
  }

  function validCorners(points, { width, height }) {
    return area(points) >= width * height * 0.015 && points.every((point, i) =>
      cross(point, points[(i + 1) % 4], points[(i + 2) % 4]) > 4);
  }

  function brightnessThreshold(gray) {
    const counts = new Uint32Array(256);
    let sum = 0;
    for (const value of gray) {
      counts[value]++;
      sum += value;
    }
    let lowerCount = 0;
    let lowerSum = 0;
    let best = 0;
    let threshold = 0;
    for (let value = 0; value < 255; value++) {
      lowerCount += counts[value];
      lowerSum += counts[value] * value;
      const upperCount = gray.length - lowerCount;
      if (!lowerCount || !upperCount) continue;
      const difference = (sum - lowerSum) / upperCount - lowerSum / lowerCount;
      const separation = lowerCount * upperCount * difference ** 2;
      if (separation > best) {
        best = separation;
        threshold = value + 1;
      }
    }
    return Math.max(100, threshold);
  }

  function largestBrightRegion(gray, width, height, threshold) {
    const visited = new Uint8Array(gray.length);
    const queue = new Int32Array(gray.length);
    const left = new Int32Array(height);
    const right = new Int32Array(height);
    let best = { size: 0, boundary: [] };
    for (let index = 0; index < gray.length; index++) {
      if (visited[index] || gray[index] < threshold) continue;
      let tail = 0;
      const visit = position => {
        if (!visited[position] && gray[position] >= threshold) {
          visited[position] = 1;
          queue[tail++] = position;
        }
      };
      visit(index);
      left.fill(width);
      right.fill(-1);
      for (let head = 0; head < tail; head++) {
        const position = queue[head];
        const x = position % width;
        const y = (position - x) / width;
        left[y] = Math.min(left[y], x);
        right[y] = Math.max(right[y], x);
        if (x > 0) visit(position - 1);
        if (x + 1 < width) visit(position + 1);
        if (y > 0) visit(position - width);
        if (y + 1 < height) visit(position + width);
      }
      if (tail <= best.size || tail < gray.length * 0.16) continue;
      const boundary = [];
      for (let y = 0; y < height; y++) {
        if (right[y] < 0) continue;
        boundary.push({ x: left[y], y });
        if (right[y] !== left[y]) boundary.push({ x: right[y], y });
      }
      best = { size: tail, boundary };
    }
    return best;
  }

  function convexHull(points) {
    const sorted = points.sort((a, b) => a.x - b.x || a.y - b.y);
    const half = ordered => {
      const hull = [];
      for (const point of ordered) {
        while (hull.length > 1 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop();
        hull.push(point);
      }
      return hull.slice(0, -1);
    };
    return half(sorted).concat(half(sorted.reverse()));
  }

  function fourCorners(hull) {
    while (hull.length > 4) {
      let remove = 0;
      let smallest = Infinity;
      for (let i = 0; i < hull.length; i++) {
        const cost = cross(hull[(i + hull.length - 1) % hull.length], hull[i], hull[(i + 1) % hull.length]);
        if (cost < smallest) {
          smallest = cost;
          remove = i;
        }
      }
      hull.splice(remove, 1);
    }
    const start = hull.reduce((best, point, index) => point.x + point.y < hull[best].x + hull[best].y ? index : best, 0);
    return hull.slice(start).concat(hull.slice(0, start));
  }

  function detect(source) {
    const sample = canvas(...fit(source.width, source.height, 350));
    const { width, height } = sample;
    sample.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, width, height);
    const gray = luminance(sample);
    const threshold = brightnessThreshold(gray);
    for (const level of new Set([threshold, Math.max(100, threshold - 22), Math.min(245, threshold + 18)])) {
      const { size, boundary } = largestBrightRegion(gray, width, height, level);
      const hull = convexHull(boundary);
      if (hull.length < 4) continue;
      const hullArea = area(hull);
      const corners = fourCorners(hull);
      const cornerArea = area(corners);
      if (cornerArea < gray.length * 0.18 || cornerArea > gray.length * 0.98 || cornerArea < hullArea * 0.91 || size < cornerArea * 0.52) continue;
      // A connected background often touches most of the frame instead of outlining the paper.
      const clipped = corners.filter(({ x, y }) => x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2);
      if (clipped.length > 1 || !validCorners(corners, sample)) continue;
      return corners.map(({ x, y }) => ({
        x: x * (source.width - 1) / (width - 1), y: y * (source.height - 1) / (height - 1)
      }));
    }
    return null;
  }

  function projection([a, b, c, d]) {
    const dx1 = b.x - c.x;
    const dx2 = d.x - c.x;
    const dx3 = a.x - b.x + c.x - d.x;
    const dy1 = b.y - c.y;
    const dy2 = d.y - c.y;
    const dy3 = a.y - b.y + c.y - d.y;
    const determinant = dx1 * dy2 - dx2 * dy1;
    const perspectiveX = (dx3 * dy2 - dx2 * dy3) / determinant;
    const perspectiveY = (dx1 * dy3 - dx3 * dy1) / determinant;
    return {
      x0: a.x, x1: b.x - a.x + perspectiveX * b.x, x2: d.x - a.x + perspectiveY * d.x,
      y0: a.y, y1: b.y - a.y + perspectiveX * b.y, y2: d.y - a.y + perspectiveY * d.y,
      perspectiveX, perspectiveY
    };
  }

  function flatten(source, corners, width, height) {
    const gray = luminance(source);
    const map = projection(corners);
    const page = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const v = y / (height - 1);
      const baseX = map.x0 + map.x2 * v;
      const baseY = map.y0 + map.y2 * v;
      const baseW = 1 + map.perspectiveY * v;
      for (let x = 0; x < width; x++) {
        const u = x / (width - 1);
        const scale = baseW + map.perspectiveX * u;
        const px = Math.max(0, Math.min(source.width - 1, (baseX + map.x1 * u) / scale));
        const py = Math.max(0, Math.min(source.height - 1, (baseY + map.y1 * u) / scale));
        const left = Math.min(source.width - 2, Math.floor(px));
        const top = Math.min(source.height - 2, Math.floor(py));
        const index = top * source.width + left;
        const fx = px - left;
        const fy = py - top;
        const upper = gray[index] * (1 - fx) + gray[index + 1] * fx;
        const lower = gray[index + source.width] * (1 - fx) + gray[index + source.width + 1] * fx;
        page[y * width + x] = upper * (1 - fy) + lower * fy;
      }
    }
    return page;
  }

  function paperTone(gray, width, height, tile) {
    const columns = Math.ceil(width / tile);
    const rows = Math.ceil(height / tile);
    const paper = new Float32Array(columns * rows);
    const counts = new Uint16Array(256);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        counts.fill(0);
        let samples = 0;
        for (let y = row * tile; y < Math.min((row + 1) * tile, height); y += 3) {
          for (let x = column * tile; x < Math.min((column + 1) * tile, width); x += 3) {
            counts[gray[y * width + x]]++;
            samples++;
          }
        }
        let value = 255;
        let lightCount = counts[value];
        while (lightCount < samples * 0.18) lightCount += counts[--value];
        // Keep large dark areas such as stamps and printed bands from being treated as background.
        paper[row * columns + column] = Math.max(110, value);
      }
    }
    return { paper, columns, rows };
  }

  function clean(gray, result) {
    const { width, height } = result;
    const tile = Math.max(28, Math.round(Math.min(width, height) / 20));
    const { paper, columns, rows } = paperTone(gray, width, height, tile);
    const context = result.getContext('2d');
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const row = Math.max(0, Math.min(rows - 1, y / tile - 0.5));
      const top = Math.floor(row);
      const bottom = Math.min(rows - 1, top + 1);
      const fy = row - top;
      for (let x = 0; x < width; x++) {
        const column = Math.max(0, Math.min(columns - 1, x / tile - 0.5));
        const left = Math.floor(column);
        const right = Math.min(columns - 1, left + 1);
        const fx = column - left;
        const upperTone = paper[top * columns + left] * (1 - fx) + paper[top * columns + right] * fx;
        const lowerTone = paper[bottom * columns + left] * (1 - fx) + paper[bottom * columns + right] * fx;
        const background = upperTone * (1 - fy) + lowerTone * fy;
        const index = y * width + x;
        const darkness = (background - gray[index]) / background;
        const value = 255 - Math.max(0, darkness - 0.018) * 355;
        const offset = index * 4;
        image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = value;
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }

  function scan(source, corners) {
    if (!validCorners(corners, source)) throw new Error('Mark all four corners of the page.');
    const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const [a, b, c, d] = corners;
    const horizontal = (length(a, b) + length(d, c)) / 2 + 1;
    const vertical = (length(a, d) + length(b, c)) / 2 + 1;
    const aspect = horizontal / vertical;
    const letter = 8.5 / 11;
    // Restore standard freight paperwork proportions after correcting camera perspective.
    const paperAspect = aspect >= 0.6 && aspect <= 1.67 ? (aspect <= 1 ? letter : 1 / letter) : aspect;
    const [width, height] = fit(Math.max(horizontal, vertical) * Math.min(1, paperAspect),
      Math.max(horizontal, vertical) * Math.min(1, 1 / paperAspect), maxScanEdge);
    if (Math.min(width, height) < 32) throw new Error('Select a larger area around the page.');
    const result = canvas(width, height);
    clean(flatten(source, corners, width, height), result);
    return result;
  }

  return { read, fullPage, validCorners, detect, scan };
})();
