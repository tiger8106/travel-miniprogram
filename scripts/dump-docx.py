import zipfile, re, sys, os, json

path = r"D:\Tige-yyds\个人资料\个人\国庆七天广西旅游攻略.docx"
z = zipfile.ZipFile(path)
xml = z.read("word/document.xml").decode("utf-8")

# 正确匹配 <w:t> 或 <w:t xxx>，排除 <w:tab .../> 与 <w:tabs>
T_RE = re.compile(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", re.S)
P_RE = re.compile(r"<w:p(?:\s[^>]*)?>.*?</w:p>", re.S)

def unesc(s):
    return (s.replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", '"').replace("&apos;", "'")
             .replace("&amp;", "&"))

paras = P_RE.findall(xml)
lines = []
for p in paras:
    texts = T_RE.findall(p)
    line = unesc("".join(texts)).strip()
    lines.append(line)

text = "\n".join(lines)
out = r"D:\on_homework\workbody\代码开发\travel-miniprogram\scripts\docx-raw.txt"
with open(out, "w", encoding="utf-8") as f:
    f.write(text)

print("paragraphs:", len(lines))
print("text len:", len(text))
print("non-empty paragraphs:", sum(1 for l in lines if l))
print("saved ->", out)
print("===== first 1200 chars =====")
print(text[:1200])
print("===== last 1500 chars =====")
print(text[-1500:])
