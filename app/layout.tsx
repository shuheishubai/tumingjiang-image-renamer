import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "图名匠｜图片批量命名工具",
  description: "在浏览器本地为图片批量命名并打包下载，图片不会上传服务器。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
