
    let parsedList = [];

    function parseMultiReservations() {
      const raw = document.getElementById('rawText').value;
      const listContainer = document.getElementById('reservationList');
      listContainer.innerHTML = '';
      parsedList = [];

      const blocks = raw.split(/상세보기|신청취소/);

      blocks.forEach(block => {
        if (!block.includes('결제완료')) return;

        const facilityMatch = block.match(/([가-힣]+테니스장|[가-힣]+체육시설)/);
        const dateMatch = block.match(/(\d{4}-\d{2}-\d{2})/);
        const timeMatch = block.match(/(\d{1,2}:\d{2}~\d{1,2}:\d{2})/);
        const courtMatch = block.match(/\)\s*(\d{1,2})\s*\d{1,2}:\d{2}/);

        if (facilityMatch && dateMatch && timeMatch) {
          const facility = facilityMatch[1];
          const date = dateMatch[1];
          const time = timeMatch[1];
          const court = courtMatch ? `${courtMatch[1]}코트` : '';

          parsedList.push({
            facility: `${facility} ${court}`.trim(),
            date: date,
            time: time
          });
        }
      });

      if (parsedList.length === 0) {
        alert('유효한 예약(결제완료 상태)을 찾지 못했습니다. 붙여넣은 텍스트를 확인해 주세요!');
        document.getElementById('resultSection').style.display = 'none';
        return;
      }

      document.getElementById('countText').innerText = parsedList.length;

      parsedList.forEach((item, idx) => {
        const itemCard = document.createElement('div');
        itemCard.className = 'item-card';
        itemCard.innerHTML = `
          <span class="badge">결제완료</span>
          <div class="item-title">🎾 ${item.facility}</div>
          <div class="item-detail">📅 <strong>일자:</strong> ${item.date}</div>
          <div class="item-detail">⏰ <strong>시간:</strong> ${item.time}</div>
          <button class="btn-add" onclick="addSingleToGCal(${idx})">개별 구글 캘린더 추가</button>
        `;
        listContainer.appendChild(itemCard);
      });

      document.getElementById('resultSection').style.display = 'block';
    }

    function addSingleToGCal(index) {
      const item = parsedList[index];
      const times = item.time.split('~').map(t => t.trim());
      
      const startDate = item.date.replace(/-/g, '');
      const startTime = times[0].replace(':', '').padStart(4, '0') + '00';
      const endTime = times[1].replace(':', '').padStart(4, '0') + '00';

      const title = encodeURIComponent(`[CourtSync] ${item.facility}`);
      const dates = `${startDate}T${startTime}/${startDate}T${endTime}`;
      const details = encodeURIComponent(`강동구 체육시설 대관 예약 (${item.facility})`);

      const gcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dates}&details=${details}`;
      window.open(gcalUrl, '_blank');
    }

    // 🚀 전체 일정을 .ics 파일로 묶어서 한번에 추가하는 함수
    function downloadAllICS() {
      if (parsedList.length === 0) return;

      let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//CourtSync//KR\n";

      parsedList.forEach(item => {
        const times = item.time.split('~').map(t => t.trim());
        const startDate = item.date.replace(/-/g, '');
        const startTime = times[0].replace(':', '').padStart(4, '0') + '00';
        const endTime = times[1].replace(':', '').padStart(4, '0') + '00';

        icsContent += "BEGIN:VEVENT\n";
        icsContent += `SUMMARY:[CourtSync] ${item.facility}\n`;
        icsContent += `DTSTART:${startDate}T${startTime}\n`;
        icsContent += `DTEND:${startDate}T${endTime}\n`;
        icsContent += `DESCRIPTION:강동구 체육시설 예약 (${item.facility})\n`;
        icsContent += "END:VEVENT\n";
      });

      icsContent += "END:VCALENDAR";

      const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.setAttribute('download', 'CourtSync_Reservations.ics');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  
