(function (global) {
  const themes = {
    sage: { name: '暖灰绿', light: ['#f7f8f4','#30382e','#6f7b6b','#e0e6db','#eaf0e4','#43664c','#a66d26','#ffffff'], dark: ['#22271f','#e3e9df','#a6b19f','#3b4435','#303c2a','#afcba3','#e9bc71','#293124'] },
    neutral: { name: '中性灰', light: ['#f7f7f7','#303033','#707075','#e2e2e6','#eaeaec','#555560','#a66d26','#ffffff'], dark: ['#252526','#e5e5e7','#a8a8af','#424247','#333338','#c2c2ce','#e9bc71','#2d2d31'] },
    blue: { name: '冷灰蓝', light: ['#f5f7fa','#2f3945','#6b7a8b','#dee5ed','#e7edf5','#4a698a','#a66d26','#ffffff'], dark: ['#20272f','#e0e8f2','#9eafc3','#35465a','#2a3c51','#a7c6eb','#e9bc71','#253343'] },
    sand: { name: '沙岩米', light: ['#faf6ef','#433b30','#807361','#e7dfd2','#f1e7d7','#826748','#a45a31','#fffaf3'], dark: ['#2b261f','#eee3d3','#b9aa94','#4b4032','#3a3024','#d5b68d','#e4aa7b','#322a21'] },
    rose: { name: '雾粉', light: ['#faf5f6','#46353c','#866f78','#eadde1','#f3e5ea','#8d5c70','#a66d26','#fffafd'], dark: ['#2c2227','#f0dfe6','#bca0ad','#4c3642','#3c2b35','#d6a2b7','#e9bc71','#34262e'] },
    lavender: { name: '浅紫', light: ['#f7f5fb','#3e3750','#7c7390','#e4deee','#ede7f6','#76618f','#a66d26','#fffcff'], dark: ['#27232f','#e9e1f5','#aaa0bf','#42384f','#332a40','#c2abdf','#e9bc71','#2f2839'] },
    mint: { name: '薄荷', light: ['#f2f9f6','#2c4039','#6a8177','#d9e8e1','#e2f2ea','#39755d','#a66d26','#fbfffd'], dark: ['#1e2b25','#dcefe4','#9bbbab','#324c40','#274034','#9bd5b7','#e9bc71','#24352c'] },
    graphite: { name: '石墨', light: ['#ebedf0','#292f39','#6c7581','#d7dce3','#dfe4ec','#465a75','#a66d26','#f5f7fa'], dark: ['#1e2228','#e5eaf1','#a0aab7','#353e4b','#2a3340','#a8bed9','#e9bc71','#252c36'] },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = themes;
  else global.DeskCueThemes = themes;
})(globalThis);
