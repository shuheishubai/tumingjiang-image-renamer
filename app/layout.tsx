import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "图名匠｜39人照片收集助手",
  description: "39人照片标准化收集、命名和本地汇总工具。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
