---
name: legal-translation
description: Trả lời bằng tiếng Anh và soạn / dịch văn bản song ngữ Việt – Anh – quy tắc trích dẫn (nguyên văn tiếng Việt + "unofficial translation"), văn phong hợp đồng tiếng Anh, và bảng thuật ngữ pháp luật thương mại Việt ↔ Anh (~170 thuật ngữ) phải dùng thống nhất.
---

# Legal translation – Vietnamese ↔ English

Dùng skill này khi: người dùng hỏi bằng tiếng Anh / giao diện tiếng Anh (`Ngôn ngữ giao diện: en`), yêu cầu trả lời song ngữ, soạn hợp đồng `language="en"` hoặc `"bilingual"`, hoặc sửa bản tiếng Anh của tài liệu song ngữ.

## 1. Quy tắc bắt buộc
1. **Văn bản gốc là tiếng Việt.** Khi trả lời bằng tiếng Anh, trích quy định pháp luật Việt Nam **nguyên văn bằng tiếng Việt** (đúng như công cụ tra cứu trả về), rồi ngay sau đó ghi bản dịch trong ngoặc:
   > "Mức phạt đối với vi phạm nghĩa vụ hợp đồng … không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm …" (unofficial translation: "The penalty for a breach of contractual obligations … shall not exceed 8% of the value of the breached part of the contractual obligation …")
   - Mẫu cố định: `"<nguyên văn tiếng Việt>" (unofficial translation: "<English>")`. `grounding_check` đối chiếu phần tiếng Việt với nguồn và **bỏ qua** phần trong `(unofficial translation: …)`; một đoạn tiếng Anh đặt trong ngoặc kép mà **không** có nhãn này sẽ bị coi là trích dẫn nguyên văn và bị báo "không có nguyên văn".
   - **Không bao giờ** trình bày bản dịch như văn bản chính thức ("Article 301 provides: '…English…'" là sai). Nếu có bản dịch tiếng Anh chính thức do cơ quan nhà nước công bố và đã mở bằng công cụ, vẫn ghi rõ nguồn của bản dịch đó.
2. **Trích dẫn giữ nguyên**: số hiệu văn bản (36/2005/QH11, 98/2020/NĐ-CP), số Điều/khoản/điểm, link, con số, ngày – y hệt như nguồn; không "dịch" số hiệu. Có thể thêm tên tiếng Anh sau tên tiếng Việt: "Luật Thương mại 2005 (Commercial Law, Law No. 36/2005/QH11)".
3. **Thuật ngữ thống nhất** theo bảng dưới (ưu tiên cách dịch trong các bản dịch tiếng Anh văn bản pháp luật Việt Nam thông dụng và thông lệ hợp đồng quốc tế). Một thuật ngữ tiếng Việt → một cách dịch trong cả câu trả lời / cả hợp đồng. Khi thuật ngữ có cách dịch khác phổ biến, có thể ghi một lần: "penalty for breach (phạt vi phạm)".
4. Độ tin cậy, chuyển chuyên gia, cảnh báo: giữ đúng quy trình `citation-check`; báo cáo bằng ngôn ngữ của câu trả lời (VD "Confidence (computed from evidence): HIGH – …").
5. Tên cơ quan, văn bản chưa có bản dịch thông dụng: giữ tên tiếng Việt, thêm diễn giải trong ngoặc.

## 2. Văn phong hợp đồng tiếng Anh
- Nghĩa vụ: **"shall"** ("Party B shall pay …"); quyền: **"may" / "shall be entitled to"**; cấm: **"shall not"**. Không dùng "will/must" lẫn lộn cho nghĩa vụ.
- "các bên" → **"the Parties"**, "mỗi bên" → "each Party", "bên kia" → "the other Party" (viết hoa khi là thuật ngữ đã định nghĩa); "Hợp đồng này" → **"this Contract"**; "sau đây gọi là" → "(hereinafter referred to as "…")"; "tại Hợp đồng này" → "herein / in this Contract"; "theo Hợp đồng này" → "hereunder / under this Contract".
- Số tiền, thời hạn: "within thirty (30) days from the date of …", "USD 65,000 (sixty-five thousand United States dollars)"; ngày theo dd/mm/yyyy hoặc "15 November 2026" – thống nhất trong một văn bản.
- Tiêu đề: "## Article 5. Payment" tương ứng "## Điều 5. Thanh toán"; khoản "1.", "2." giữ số; điểm "a)", "b)".
- Song ngữ (`document_create(language="bilingual")`): `markdown` (tiếng Việt) và `markdown_en` (tiếng Anh) phải **cùng cấu trúc**: cùng số tiêu đề, cùng thứ tự, cùng số Điều; mỗi đoạn/khoản tiếng Việt có đúng một đoạn/khoản tiếng Anh theo cùng thứ tự (để hai cột căn đúng từng dòng). Điều khoản ngôn ngữ ("Hợp đồng này được lập bằng tiếng Việt và tiếng Anh …") được công cụ tự thêm nếu chưa có – không cần viết. Bản ưu tiên mặc định là tiếng Việt (`prevailing="vi"`); chỉ đổi sang `"en"` khi người dùng yêu cầu.

## 3. Bảng thuật ngữ Việt ↔ Anh

### 3.1 Văn bản pháp luật, cấu trúc, cơ quan
| Tiếng Việt | English |
|---|---|
| Hiến pháp | Constitution |
| Bộ luật Dân sự | Civil Code |
| Bộ luật Tố tụng dân sự | Civil Procedure Code |
| Luật Thương mại | Commercial Law (Law on Commerce) |
| Luật Doanh nghiệp | Law on Enterprises |
| Luật Đầu tư | Law on Investment |
| Luật Trọng tài thương mại | Law on Commercial Arbitration |
| Luật Quản lý ngoại thương | Law on Foreign Trade Management |
| Luật Hải quan | Customs Law (Law on Customs) |
| Luật Thuế xuất khẩu, thuế nhập khẩu | Law on Export and Import Duties |
| Luật Sở hữu trí tuệ | Law on Intellectual Property |
| Nghị định | Decree |
| Thông tư | Circular |
| Nghị quyết | Resolution |
| Quyết định | Decision |
| Pháp lệnh | Ordinance |
| văn bản quy phạm pháp luật | legislative document (legal normative document) |
| văn bản hợp nhất | consolidated text |
| Phần / Chương / Mục | Part / Chapter / Section |
| Điều / khoản / điểm | Article / Clause / Point |
| Phụ lục | Appendix (Annex) |
| sửa đổi, bổ sung | amending and supplementing |
| quy định chi tiết, hướng dẫn thi hành | detailing and guiding the implementation of |
| hiệu lực thi hành | entry into force (effect) |
| còn hiệu lực / hết hiệu lực / hết hiệu lực một phần | in force / no longer in force (expired) / partially expired |
| Quốc hội | National Assembly |
| Chính phủ / Thủ tướng Chính phủ | Government / Prime Minister |
| Bộ Công Thương | Ministry of Industry and Trade (MOIT) |
| Bộ Tài chính | Ministry of Finance |
| Tòa án nhân dân tối cao | Supreme People's Court |
| Tòa án nhân dân cấp tỉnh | provincial-level People's Court |
| Hội đồng Thẩm phán | Council of Judges |
| án lệ | precedent |
| bản án / quyết định | judgment / decision |
| sơ thẩm / phúc thẩm / giám đốc thẩm | first-instance / appellate / cassation |

### 3.2 Chủ thể
| Tiếng Việt | English |
|---|---|
| Bên A / Bên B | Party A / Party B |
| các bên | the Parties |
| bên bán / bên mua | the Seller / the Buyer |
| bên vi phạm | the breaching party (the party in breach) |
| bên bị vi phạm | the aggrieved party |
| bên thứ ba | third party |
| thương nhân | trader |
| thương nhân nước ngoài | foreign trader |
| pháp nhân | juridical person (legal entity) |
| cá nhân | individual |
| doanh nghiệp | enterprise |
| công ty trách nhiệm hữu hạn | limited liability company |
| công ty cổ phần | joint-stock company |
| hộ kinh doanh | household business |
| người đại diện theo pháp luật | legal representative |
| người đại diện theo ủy quyền | authorised representative |
| giấy ủy quyền | power of attorney (letter of authorisation) |
| bên giao đại lý / bên đại lý | principal / agent |
| bên cung ứng dịch vụ / bên sử dụng dịch vụ | service provider / service user (customer) |
| người vận chuyển / người gửi hàng / người nhận hàng | carrier / consignor (shipper) / consignee |

### 3.3 Giao kết, hiệu lực, chấm dứt hợp đồng
| Tiếng Việt | English |
|---|---|
| hợp đồng | contract |
| hợp đồng mua bán hàng hóa | contract for the sale of goods (sales contract) |
| mua bán hàng hóa quốc tế | international sale of goods |
| hợp đồng dịch vụ | service contract |
| hợp đồng đại lý | agency contract |
| hợp đồng phân phối | distribution agreement |
| hợp đồng khung | framework agreement |
| phụ lục hợp đồng | contract appendix |
| giao kết hợp đồng | conclusion of a contract (entering into a contract) |
| đề nghị giao kết hợp đồng / chấp nhận | offer / acceptance |
| thỏa thuận | agreement; to agree |
| điều khoản | term; clause |
| nội dung chủ yếu của hợp đồng | principal terms of the contract |
| có hiệu lực kể từ | takes effect from |
| hiệu lực của hợp đồng | effect (validity) of the contract |
| vô hiệu | invalid (void) |
| điều cấm của luật | prohibitions of law |
| sửa đổi hợp đồng | amendment of the contract |
| tạm ngừng thực hiện hợp đồng | suspension of contract performance |
| đình chỉ thực hiện hợp đồng | stoppage of contract performance |
| hủy bỏ hợp đồng | cancellation (rescission) of the contract |
| đơn phương chấm dứt thực hiện hợp đồng | unilateral termination of the contract |
| chấm dứt hợp đồng | termination of the contract |
| hoàn cảnh thay đổi cơ bản | fundamental change of circumstances |
| quyền và nghĩa vụ | rights and obligations |
| trách nhiệm | liability; responsibility |
| bảo mật thông tin | confidentiality |
| bằng văn bản | in writing |
| thông báo | notice; to notify |
| biện pháp bảo đảm | security (security interest) |
| đặt cọc / ký quỹ | deposit / escrow deposit |
| bảo lãnh / bảo lãnh thực hiện hợp đồng | guarantee / performance guarantee (performance bond) |
| cầm cố / thế chấp | pledge / mortgage |

### 3.4 Hàng hóa, giao nhận, chứng từ
| Tiếng Việt | English |
|---|---|
| hàng hóa | goods |
| đối tượng của hợp đồng | subject matter of the contract |
| số lượng / chất lượng / quy cách | quantity / quality / specifications |
| bao bì / đóng gói / ký mã hiệu | packaging / packing / marking |
| xuất xứ hàng hóa | origin of goods |
| giấy chứng nhận xuất xứ (C/O) | certificate of origin (C/O) |
| giao hàng / nhận hàng | delivery / taking delivery (receipt) |
| địa điểm giao hàng / thời hạn giao hàng | place of delivery / time of delivery |
| giao hàng từng phần | partial delivery (delivery by instalments) |
| giao thiếu hàng / giao hàng không phù hợp với hợp đồng | short delivery / delivery of goods not conforming with the contract |
| kiểm tra hàng hóa trước khi giao hàng | inspection of goods before delivery |
| chuyển rủi ro | passing of risk |
| chuyển quyền sở hữu | transfer of ownership (title) |
| chứng từ liên quan đến hàng hóa | documents relating to the goods |
| vận đơn | bill of lading (B/L) |
| hóa đơn thương mại | commercial invoice |
| phiếu đóng gói | packing list |
| giấy chứng nhận chất lượng / số lượng | certificate of quality / quantity |
| bảo hiểm hàng hóa | cargo insurance |
| bảo hành | warranty |
| cảng xếp hàng / cảng dỡ hàng | port of loading / port of discharge |

### 3.5 Giá, thanh toán
| Tiếng Việt | English |
|---|---|
| giá / đơn giá / tổng giá trị hợp đồng | price / unit price / total contract value |
| thanh toán / phương thức thanh toán | payment / method of payment |
| thời hạn thanh toán | time limit for payment (payment term) |
| đồng tiền thanh toán / tỷ giá | currency of payment / exchange rate |
| chuyển khoản | bank transfer |
| thư tín dụng (L/C) | letter of credit (L/C) |
| nhờ thu | documentary collection |
| tạm ứng / trả trước | advance payment |
| chậm thanh toán | late payment (delay in payment) |
| tiền lãi trên số tiền chậm trả | interest on delayed payment |
| thuế giá trị gia tăng (GTGT) | value added tax (VAT) |
| đã bao gồm / chưa bao gồm thuế GTGT | inclusive / exclusive of VAT |
| hóa đơn hợp lệ | valid invoice |
| mã số thuế | tax identification number (tax code) |
| số tài khoản / ngân hàng thụ hưởng | account number / beneficiary bank |

### 3.6 Vi phạm và chế tài
| Tiếng Việt | English |
|---|---|
| vi phạm hợp đồng | breach of contract |
| vi phạm cơ bản | fundamental breach |
| chế tài trong thương mại | commercial remedies |
| buộc thực hiện đúng hợp đồng | specific performance of the contract |
| phạt vi phạm | penalty for breach (penalty) |
| mức phạt | penalty amount (penalty rate) |
| bồi thường thiệt hại | compensation for damage (damages) |
| thiệt hại thực tế, trực tiếp | actual and direct loss |
| khoản lợi trực tiếp đáng lẽ được hưởng | direct profit that would have been earned |
| nghĩa vụ hạn chế tổn thất | obligation to mitigate losses |
| bất khả kháng / sự kiện bất khả kháng | force majeure / force majeure event |
| các trường hợp miễn trách nhiệm | cases of exemption from liability |
| miễn trách nhiệm / loại trừ trách nhiệm / giới hạn trách nhiệm | exemption from / exclusion of / limitation of liability |
| khắc phục vi phạm | remedy the breach (cure) |
| lỗi | fault |

### 3.7 Giải quyết tranh chấp, luật áp dụng
| Tiếng Việt | English |
|---|---|
| tranh chấp / giải quyết tranh chấp | dispute / dispute settlement (resolution) |
| thương lượng | negotiation |
| hòa giải / hòa giải thương mại | mediation / commercial mediation |
| trọng tài thương mại | commercial arbitration |
| trung tâm trọng tài / trọng tài viên | arbitration centre / arbitrator |
| Trung tâm Trọng tài Quốc tế Việt Nam (VIAC) | Vietnam International Arbitration Centre (VIAC) |
| thỏa thuận trọng tài / phán quyết trọng tài | arbitration agreement / arbitral award |
| quy tắc tố tụng trọng tài | rules of arbitration |
| Tòa án có thẩm quyền | competent court |
| luật áp dụng | governing law (applicable law) |
| khởi kiện | initiate a lawsuit (file a claim) |
| thời hạn khiếu nại | time limit for lodging complaints |
| thời hiệu khởi kiện | statute of limitations for initiating lawsuits |
| công nhận và cho thi hành | recognition and enforcement |

### 3.8 Thương mại quốc tế, hải quan, phòng vệ thương mại
| Tiếng Việt | English |
|---|---|
| xuất khẩu / nhập khẩu / tạm nhập tái xuất | export / import / temporary import for re-export |
| giấy phép xuất khẩu, nhập khẩu | export / import licence |
| thủ tục hải quan / tờ khai hải quan | customs procedures / customs declaration |
| mã số hàng hóa (mã HS) | HS code (tariff classification code) |
| thuế nhập khẩu ưu đãi đặc biệt | special preferential import duty |
| hạn ngạch / hạn ngạch thuế quan | quota / tariff quota |
| hiệp định thương mại tự do (FTA) | free trade agreement (FTA) |
| quy tắc xuất xứ / tự chứng nhận xuất xứ | rules of origin / self-certification of origin |
| phòng vệ thương mại | trade remedies |
| chống bán phá giá / thuế chống bán phá giá | anti-dumping / anti-dumping duty |
| biên độ bán phá giá | dumping margin |
| chống trợ cấp / thuế chống trợ cấp | anti-subsidy (countervailing) / countervailing duty |
| tự vệ / biện pháp tự vệ | safeguard / safeguard measure |
| chống lẩn tránh biện pháp phòng vệ thương mại | anti-circumvention of trade remedies |
| cơ quan điều tra / bên liên quan | investigating authority / interested party |
| bản câu hỏi điều tra | questionnaire |
| kết luận sơ bộ / kết luận cuối cùng | preliminary determination / final determination |
| rà soát cuối kỳ / rà soát hành chính | sunset (expiry) review / administrative review |
| Cục Phòng vệ thương mại | Trade Remedies Authority of Vietnam (TRAV) |
| hàng rào kỹ thuật trong thương mại (TBT) | technical barriers to trade (TBT) |
| biện pháp vệ sinh dịch tễ (SPS) | sanitary and phytosanitary measures (SPS) |

### 3.9 Đại lý, phân phối, dịch vụ, sở hữu trí tuệ
| Tiếng Việt | English |
|---|---|
| đại lý thương mại | commercial agency |
| ủy thác mua bán hàng hóa | entrustment of purchase and sale of goods |
| môi giới thương mại | commercial brokerage |
| nhượng quyền thương mại | franchising |
| khuyến mại / quảng cáo thương mại | sales promotion / commercial advertising |
| độc quyền / phân phối độc quyền | exclusivity / exclusive distribution |
| khu vực (lãnh thổ) phân phối | distribution territory |
| chỉ tiêu doanh số | sales target |
| thù lao / hoa hồng | remuneration / commission |
| quyền sở hữu trí tuệ / nhãn hiệu / bí mật kinh doanh | intellectual property rights / trademark / trade secret |

### 3.10 Cụm từ soạn thảo
| Tiếng Việt | English |
|---|---|
| căn cứ | pursuant to (based on) |
| theo quy định của pháp luật | in accordance with the law (as prescribed by law) |
| trừ trường hợp | except where (unless) |
| trong vòng … ngày kể từ ngày … | within … days from the date of … |
| có trách nhiệm | shall (be responsible for) |
| có quyền | shall be entitled to (may) |
| không được | shall not |
| sau đây gọi là | hereinafter referred to as |
| đại diện bởi / chức vụ | represented by / position |
| trụ sở chính | head office (registered office) |
| Giấy chứng nhận đăng ký doanh nghiệp | Enterprise Registration Certificate |
| Hợp đồng được lập thành 04 bản có giá trị pháp lý như nhau, mỗi bên giữ 02 bản | This Contract is made in four (04) originals of equal legal validity, each Party keeping two (02) originals |
| Hợp đồng này có hiệu lực kể từ ngày ký | This Contract takes effect from the date of signing |
| ĐẠI DIỆN BÊN A / ĐẠI DIỆN BÊN B | FOR AND ON BEHALF OF PARTY A / FOR AND ON BEHALF OF PARTY B |
| (Ký, ghi rõ họ tên, chức vụ và đóng dấu) | (Signature, full name, title and seal) |
| CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM – Độc lập – Tự do – Hạnh phúc | SOCIALIST REPUBLIC OF VIETNAM – Independence – Freedom – Happiness |

Bảng trên là cách dịch thống nhất của nền tảng, không phải bản dịch chính thức; khi người dùng hoặc đối tác đã dùng một cách dịch khác trong hợp đồng đang sửa, giữ cách dịch của hợp đồng đó cho nhất quán.
