# LegalAI – Bộ hỏi–đáp pháp luật (QA)

**6.000 cặp hỏi–đáp song ngữ Việt–Anh**, sinh từ **2.000 điều luật** Việt Nam về hợp đồng, thương mại và tố tụng.
Mỗi điều luật cho ra 3 cặp hỏi–đáp. Đây là một phần của bộ dữ liệu Nội dung 3, dự án LegalAI (FTU Tech Lab, Đại học Ngoại thương).

File: `qa.jsonl`. Mỗi dòng là một điều luật, dạng JSON.

## Nguồn

Toàn văn điều luật lấy từ Cơ sở dữ liệu quốc gia về văn bản pháp luật (vbpl.vn) và Công báo:

| Số điều | Văn bản |
|---:|---|
| 625 | Bộ luật Dân sự số 91/2015/QH13 |
| 508 | Bộ luật Tố tụng dân sự số 92/2015/QH13 |
| 325 | Bộ luật Hàng hải số 95/2015/QH13 |
| 215 | Luật Doanh nghiệp số 59/2020/QH14 |
| 200 | Luật Thương mại số 36/2005/QH11 |
| 50 | Luật Đầu tư số 143/2025/QH15 |
| 39 | Luật Thương mại điện tử số 122/2025/QH15 |
| 35 | Luật Hòa giải ở cơ sở số 16/2026/QH16 |
| 3 | Luật số 24/2026/QH16 sửa đổi, bổ sung Luật Đầu tư |

## Cấu trúc một dòng

```jsonc
{
  "key": "vbpl:96115#5",               // mã văn bản # số điều
  "task": "qa",
  "source_meta": {                     // nguồn gốc điều luật
    "title": "Bộ luật Tố tụng dân sự số 92/2015/QH13",
    "number": "92/2015/QH13", "issuer": "Quốc hội",
    "issued_date": "2015-11-25", "effective_date": "2016-07-01",
    "status": "Hết hiệu lực một phần", "article": 5,
    "url": "https://vbpl.vn/...", "file_urls": ["..."]
  },
  "labels": {
    "qa_pairs": [                      // 3 cặp cho mỗi điều
      {
        "question_vi": "...", "answer_vi": "...",
        "question_en": "...", "answer_en": "...",
        "citations": ["Khoản 1 Điều 5 Bộ luật Tố tụng dân sự số 92/2015/QH13"],
        "question_type": "quyen_nghia_vu",
        "difficulty": "co_ban",
        "persona": "dnnvv",
        "should_escalate": false
      }
    ],
    "confidence": 0.99
  },
  "label_model": "...",                // mô hình đã gán nhãn
  "labelled_at": "2026-09-25T08:09:14.815Z",
  "needs_review": false,
  "reviewed": false
}
```

## Ý nghĩa các trường nhãn

| Trường | Giá trị | Ý nghĩa |
|---|---|---|
| `question_type` | `tinh_huong_thuc_te` (1.904), `quyen_nghia_vu` (1.259), `dieu_kien_ap_dung` (1.134), `thu_tuc` (597), `dinh_nghia` (544), `thoi_han` (373), `che_tai` (189) | Loại câu hỏi |
| `difficulty` | `co_ban` (3.068), `trung_binh` (2.143), `nang_cao` (789) | Độ khó |
| `persona` | `dnnvv` – doanh nghiệp nhỏ và vừa (2.855), `phap_che_doanh_nghiep` – pháp chế doanh nghiệp (2.503), `doanh_nghiep_xuat_khau` – doanh nghiệp xuất khẩu (642) | Người hỏi giả định |
| `should_escalate` | `true` (1.154), `false` (4.846) | Câu hỏi nên chuyển cho luật sư thay vì chỉ trả lời tự động |
| `citations` | danh sách | Điều, khoản làm căn cứ cho câu trả lời |
| `confidence` | 0–1 | Độ tự tin của người gán (trung bình 0,92) |
| `needs_review` | `true` ở 51 điều | Cần chuyên gia xem lại |

## Lưu ý khi dùng

- Nhãn được gán tự động bằng mô hình ngôn ngữ (xem trường `label_model`) và **chưa được chuyên gia pháp lý duyệt** (`reviewed: false`).
- Câu trả lời dựa trên nội dung điều luật tại thời điểm thu thập (09/2026). Hãy kiểm tra `status` và văn bản sửa đổi trước khi dùng.
- Đây không phải tư vấn pháp lý.
