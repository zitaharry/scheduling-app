"use client";

import { CalendarCheckIcon } from "lucide-react";
import React from "react";
import DocumentCountCard from "./DocumentCountCard";

const TotalBookingsCard = () => {
  return <DocumentCountCard documentType="booking" title="Total Bookings" icon={CalendarCheckIcon} />;
};

export default TotalBookingsCard;
