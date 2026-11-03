from PIL import Image, ImageDraw
from pathlib import Path

size = 1024
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.rounded_rectangle((0, 0, 1023, 1023), radius=232, fill='#f7f9ff')
mask = Image.new('L', (size, size), 0)
points = [(58, 201), (116, 63), (128, 46), (140, 63), (199, 201), (162, 201), (128, 116), (94, 201)]
ImageDraw.Draw(mask).polygon([(x*4,y*4) for x,y in points], fill=255)
gradient = Image.new('RGBA', (size, size))
gd = ImageDraw.Draw(gradient)
for y in range(size):
    t = y/(size-1)
    color = tuple(round(a*(1-t)+b*t) for a,b in zip((172,156,236),(66,126,230)))
    gd.line((0,y,size,y), fill=(*color,255))
img.paste(gradient, (0,0), mask)
ImageDraw.Draw(img).polygon([(x*4,y*4) for x,y in [(128,157),(154,190),(128,219),(102,190)]], fill='#91cbd8')
img.resize((256,256), Image.Resampling.LANCZOS).save(Path(__file__).parent/'icon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
